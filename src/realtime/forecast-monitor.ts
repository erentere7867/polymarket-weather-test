/**
 * Forecast Monitor
 * Polls weather APIs and updates DataStore with latest forecasts
 * 
 * Webhook Integration:
 * - Integrates with event bus to listen for FORECAST_TRIGGER events
 * - Delegates to FetchModeController when entering FETCH_MODE
 * - Uses IdlePollingService when in IDLE mode
 */

import { WeatherService } from '../weather/index.js';
import type { WeatherData } from '../weather/types.js';
import { DataStore } from './data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { eventBus, ForecastTriggerEvent, FetchModeEnterEvent, FetchModeExitEvent } from './event-bus.js';
import { ForecastStateMachine, forecastStateMachine } from './forecast-state-machine.js';
import { FetchModeController } from './fetch-mode-controller.js';
import { IdlePollingService } from './idle-polling-service.js';

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private regularPollIntervalMs: number;
    private isRunning: boolean = false;
    private regularPollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();
    public cacheTtlMs: number = 0;
    private initializedMarkets: Set<string> = new Set();

    // Callback for significant changes
    public onForecastChanged: ((marketId: string, changeAmount: number) => void) | null = null;

    // Webhook integration components
    private stateMachine: ForecastStateMachine;
    private fetchModeController: FetchModeController | null = null;
    private idlePollingService: IdlePollingService | null = null;
    private eventBusUnsubscribers: Array<() => void> = [];
    private useWebhookMode: boolean;

    constructor(store: DataStore, pollIntervalMs?: number, weatherService?: WeatherService) {
        this.store = store;
        this.weatherService = weatherService || new WeatherService();
        // Use config defaults
        this.regularPollIntervalMs = pollIntervalMs ?? config.forecastPollIntervalMs;
        
        // Initialize webhook mode
        this.useWebhookMode = config.USE_WEBHOOK_MODE;
        this.stateMachine = forecastStateMachine;
        
        // Setup event bus listeners if webhook mode is enabled
        if (this.useWebhookMode) {
            this.setupEventBusListeners();
            this.initializeWebhookComponents();
        }
        
        logger.info(`ForecastMonitor initialized with ${this.regularPollIntervalMs / 1000}s regular interval`);
        logger.info(`Webhook mode: ${this.useWebhookMode ? 'enabled' : 'disabled'}`);
    }

    /**
     * Setup event bus listeners for webhook integration
     */
    private setupEventBusListeners(): void {
        // Listen for FORECAST_TRIGGER events from webhooks
        const unsubscribeTrigger = eventBus.on('FORECAST_TRIGGER', (event: ForecastTriggerEvent) => {
            this.handleForecastTrigger(event);
        });
        this.eventBusUnsubscribers.push(unsubscribeTrigger);

        // Listen for FETCH_MODE_ENTER events
        const unsubscribeEnter = eventBus.on('FETCH_MODE_ENTER', (event: FetchModeEnterEvent) => {
            this.handleFetchModeEnter(event);
        });
        this.eventBusUnsubscribers.push(unsubscribeEnter);

        // Listen for FETCH_MODE_EXIT events
        const unsubscribeExit = eventBus.on('FETCH_MODE_EXIT', (event: FetchModeExitEvent) => {
            this.handleFetchModeExit(event);
        });
        this.eventBusUnsubscribers.push(unsubscribeExit);
    }

    /**
     * Initialize webhook-based components
     */
    private initializeWebhookComponents(): void {
        // Create fetch mode controller
        this.fetchModeController = new FetchModeController(
            this.stateMachine,
            this.store,
            undefined,
            this.weatherService
        );

        // Create idle polling service
        this.idlePollingService = new IdlePollingService(
            this.stateMachine,
            this.store,
            undefined,
            this.weatherService
        );
    }

    /**
     * Handle FORECAST_TRIGGER event from webhook
     */
    private handleForecastTrigger(event: ForecastTriggerEvent): void {
        const { cityId, provider, triggerTimestamp } = event.payload;
        
        logger.info(`🎯 Forecast trigger received from ${provider} for ${cityId}`, {
            timestamp: triggerTimestamp.toISOString(),
        });

        // Enter FETCH_MODE for the city (idempotent - will reset if already in FETCH_MODE)
        this.stateMachine.enterFetchMode(cityId, 'webhook');
    }

    /**
     * Handle FETCH_MODE_ENTER event
     */
    private handleFetchModeEnter(event: FetchModeEnterEvent): void {
        const { cityId, reason } = event.payload;
        
        logger.debug(`Fetch mode entered for ${cityId}`, { reason });

        // In webhook mode, we rely on the FetchModeController for active polling
        // The IdlePollingService will automatically skip cities in FETCH_MODE
    }

    /**
     * Handle FETCH_MODE_EXIT event
     */
    private handleFetchModeExit(event: FetchModeExitEvent): void {
        const { cityId, reason } = event.payload;
        
        logger.debug(`Fetch mode exited for ${cityId}`, { reason });

        // The IdlePollingService will automatically resume polling for this city
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        
        if (this.useWebhookMode) {
            // In webhook mode, start the idle polling service
            // The FetchModeController is event-driven and starts automatically
            this.idlePollingService?.start();
            
            // Still run regular polling as a fallback
            this.scheduleRegularPoll();
            
            logger.info('ForecastMonitor started in webhook mode with idle polling');
        } else {
            // Legacy mode: Start regular polling
            this.scheduleRegularPoll();
        }
        
        logger.info('ForecastMonitor started');
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        this.isRunning = false;
        if (this.regularPollTimeout) {
            clearTimeout(this.regularPollTimeout);
            this.regularPollTimeout = null;
        }
        
        // Stop webhook mode components
        this.idlePollingService?.stop();
        this.fetchModeController?.dispose();
        
        // Unsubscribe from event bus
        for (const unsubscribe of this.eventBusUnsubscribers) {
            unsubscribe();
        }
        this.eventBusUnsubscribers = [];
        
        logger.info('ForecastMonitor stopped');
    }

    /**
     * Update polling intervals dynamically
     */
    updatePollInterval(regularMs?: number): void {
        if (regularMs !== undefined) {
            this.regularPollIntervalMs = regularMs;
            logger.info(`Regular poll interval updated to ${regularMs}ms`);
        }
        
        // Reset timeout with new interval
        if (this.regularPollTimeout) {
            clearTimeout(this.regularPollTimeout);
            this.scheduleRegularPoll();
        }
    }

    /**
     * Get current polling interval
     */
    getPollInterval(): number {
        return this.regularPollIntervalMs;
    }

    /**
     * Schedule the next regular poll
     */
    private scheduleRegularPoll(): void {
        if (!this.isRunning) return;
        this.regularPollTimeout = setTimeout(() => this.pollRegular(), this.regularPollIntervalMs);
    }

    /**
     * Poll all cities
     */
    private async pollRegular(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const markets = this.store.getAllMarkets();
            const cities = this.getCitiesFromMarkets(markets);
            
            if (cities.size > 0) {
                // In webhook mode, skip cities that are in FETCH_MODE
                const citiesToPoll = this.useWebhookMode
                    ? this.filterOutFetchModeCities(cities)
                    : cities;
                
                if (citiesToPoll.size > 0) {
                    logger.debug(`Polling ${citiesToPoll.size} cities`);
                    await this.pollCities(citiesToPoll);
                }
            }
        } catch (error) {
            logger.error('Regular poll failed', { error: (error as Error).message });
        }

        // Schedule next poll
        this.scheduleRegularPoll();
    }

    /**
     * Get cities from markets
     */
    private getCitiesFromMarkets(markets: ParsedWeatherMarket[]): Map<string, ParsedWeatherMarket[]> {
        const cityGroups = new Map<string, ParsedWeatherMarket[]>();

        for (const market of markets) {
            if (!market.city) continue;
            
            const list = cityGroups.get(market.city) || [];
            list.push(market);
            cityGroups.set(market.city, list);
        }

        return cityGroups;
    }

    /**
     * Filter out cities that are currently in FETCH_MODE
     */
    private filterOutFetchModeCities(cities: Map<string, ParsedWeatherMarket[]>): Map<string, ParsedWeatherMarket[]> {
        const filtered = new Map<string, ParsedWeatherMarket[]>();
        
        for (const [cityId, markets] of cities.entries()) {
            const normalizedCityId = cityId.toLowerCase().replace(/\s+/g, '_');
            if (!this.stateMachine.isInFetchMode(normalizedCityId)) {
                filtered.set(cityId, markets);
            } else {
                logger.debug(`Skipping ${cityId} in regular poll: in FETCH_MODE`);
            }
        }
        
        return filtered;
    }

    /**
     * Poll a set of cities using batch fetching
     */
    private async pollCities(cityGroups: Map<string, ParsedWeatherMarket[]>): Promise<void> {
        const cities = Array.from(cityGroups.keys());
        if (cities.length === 0) return;

        try {
            // Use batch fetching for efficiency
            const batchResults = await this.weatherService.getForecastBatch(
                cities.map(city => ({ cityName: city }))
            );

            // Process each city's results
            const updatePromises = Array.from(cityGroups.entries()).map(([city, cityMarkets]) => {
                const weatherData = batchResults.get(city);
                if (weatherData) {
                    // Update cache
                    this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
                    // Process markets for this city
                    return this.processCityMarkets(city, cityMarkets, weatherData);
                }
                return Promise.resolve();
            });
            await Promise.all(updatePromises);
        } catch (error) {
            logger.error('Batch fetch failed, falling back to individual fetches', { error: (error as Error).message });
            // Fallback to individual fetches
            const updatePromises = Array.from(cityGroups.entries()).map(([city, cityMarkets]) =>
                this.updateCityForecasts(city, cityMarkets).catch(error => {
                    logger.error(`Failed to update forecasts for ${city}`, { error: (error as Error).message });
                })
            );
            await Promise.all(updatePromises);
        }
    }

    /**
     * Get webhook mode status
     */
    isWebhookModeEnabled(): boolean {
        return this.useWebhookMode;
    }

    /**
     * Get state machine stats (for monitoring)
     */
    getStateMachineStats() {
        return this.stateMachine.getStats();
    }

    /**
     * Get idle polling service stats (for monitoring)
     */
    getIdlePollingStats() {
        return this.idlePollingService?.getStats();
    }

    /**
     * Manually enter FETCH_MODE for a city (for testing or manual override)
     */
    enterFetchMode(cityId: string): void {
        this.stateMachine.enterFetchMode(cityId, 'manual');
    }

    /**
     * Manually exit FETCH_MODE for a city (for testing or manual override)
     */
    exitFetchMode(cityId: string): void {
        this.stateMachine.exitFetchMode(cityId, 'manual');
    }

    private async updateCityForecasts(city: string, markets: ParsedWeatherMarket[]): Promise<void> {
        try {
            // Check cache validity
            let weatherData: WeatherData;
            const cached = this.cityCache.get(city);

            // 12s cache to balance speed and rate limits
            if (cached && (Date.now() - cached.timestamp.getTime() < this.cacheTtlMs)) {
                weatherData = cached.data;
            } else {
                weatherData = await this.weatherService.getForecastByCity(city);
                this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
            }

            for (const market of markets) {
                if (!market.targetDate) continue;

                let probability = 0;
                let forecastValue = 0;
                let hasValidForecast = false;

                // Extract forecast value based on metric
                if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
                    // Use static helper to avoid extra API call
                    const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                    if (high !== null && market.threshold !== undefined) {
                        forecastValue = high;

                        // Normalize threshold to F for comparison (forecast is always F)
                        let thresholdF = market.threshold;
                        if (market.thresholdUnit === 'C') {
                            thresholdF = (market.threshold * 9 / 5) + 32;
                        }

                        probability = this.weatherService.calculateTempExceedsProbability(high, thresholdF);
                        if (market.comparisonType === 'below') probability = 1 - probability;
                        hasValidForecast = true;
                    }
                } else if (market.metricType === 'temperature_low') {
                    const low = WeatherService.calculateLow(weatherData, market.targetDate);
                    if (low !== null && market.threshold !== undefined) {
                        forecastValue = low;

                        // Normalize threshold to F
                        let thresholdF = market.threshold;
                        if (market.thresholdUnit === 'C') {
                            thresholdF = (market.threshold * 9 / 5) + 32;
                        }

                        probability = this.weatherService.calculateTempExceedsProbability(low, thresholdF);
                        // For low temp, "below" usually means "colder than". 
                        // Probability calculated is "exceeds" (warmer than).
                        // If market is "Low < 30", and forecast is 25. Exceeds(25, 30) -> Low prob.
                        // We want prob of being BELOW. So 1 - Exceeds.
                        if (market.comparisonType === 'below') {
                            probability = 1 - probability;
                        } else {
                            // Market "Low > 30". Forecast 35. Exceeds(35, 30) -> High prob. Correct.
                        }
                        hasValidForecast = true;
                    }
                } else if (market.metricType === 'temperature_range') {
                    const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                    if (high !== null && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
                        forecastValue = high;

                        let minF = market.minThreshold;
                        let maxF = market.maxThreshold;
                        if (market.thresholdUnit === 'C') {
                            minF = (market.minThreshold * 9 / 5) + 32;
                            maxF = (market.maxThreshold * 9 / 5) + 32;
                        }

                        const probAboveMin = this.weatherService.calculateTempExceedsProbability(high, minF);
                        const probAboveMax = this.weatherService.calculateTempExceedsProbability(high, maxF);
                        probability = Math.max(0, Math.min(1, probAboveMin - probAboveMax));
                        hasValidForecast = true;
                    }
                } else if (market.metricType === 'precipitation') {
                    const targetDateObj = new Date(market.targetDate);
                    targetDateObj.setUTCHours(0, 0, 0, 0);

                    const dayForecasts = weatherData.hourly.filter((h: { timestamp: Date }) => {
                        const hourDate = new Date(h.timestamp);
                        hourDate.setUTCHours(0, 0, 0, 0);
                        return hourDate.getTime() === targetDateObj.getTime();
                    });

                    if (dayForecasts.length > 0) {
                        const maxPrecipProb = Math.max(...dayForecasts.map((h: { probabilityOfPrecipitation: number }) => h.probabilityOfPrecipitation));
                        forecastValue = maxPrecipProb;
                        probability = maxPrecipProb / 100;
                        if (market.comparisonType === 'below') probability = 1 - probability;
                        hasValidForecast = true;
                    }
                }

                if (!hasValidForecast) continue;

                // SPEED ARBITRAGE: Detect if forecast value actually changed
                const currentState = this.store.getMarketState(market.market.id);
                const previousValue = currentState?.lastForecast?.forecastValue;
                const previousSource = currentState?.lastForecast?.weatherData?.source;
                const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

                const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

                let significantChangeThreshold: number;
                switch (market.metricType) {
                    case 'temperature_high':
                    case 'temperature_low':
                    case 'temperature_threshold':
                    case 'temperature_range':
                        significantChangeThreshold = 1;
                        break;
                    default:
                        significantChangeThreshold = 1;
                }

                const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
                const valueChanged = !sourceChanged && changeAmount >= significantChangeThreshold;

                const now = new Date();

                // Track when the change occurred
                // If changed now, use current time. Otherwise, keep previous change time
                const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

                const isNew = !this.initializedMarkets.has(market.market.id);
                if (isNew) {
                    this.initializedMarkets.add(market.market.id);
                }

                const realChange = valueChanged && !isNew;

                if (realChange) {
                    logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`);
                    
                    if (this.onForecastChanged) {
                        this.onForecastChanged(market.market.id, changeAmount);
                    }
                }

                const snapshot: ForecastSnapshot = {
                    marketId: market.market.id,
                    weatherData,
                    forecastValue,
                    probability,
                    timestamp: now,
                    previousValue,
                    valueChanged: realChange,
                    changeAmount,
                    changeTimestamp,
                };

                this.store.updateForecast(market.market.id, snapshot);
            }

        } catch (error) {
            // Error already logged in poll() for parallel execution
            throw error;
        }
    }

    /**
     * Process markets for a city using already-fetched weather data
     * Used by batch fetching to avoid duplicate API calls
     */
    private async processCityMarkets(city: string, markets: ParsedWeatherMarket[], weatherData: WeatherData): Promise<void> {
        for (const market of markets) {
            if (!market.targetDate) continue;

            let probability = 0;
            let forecastValue = 0;
            let hasValidForecast = false;

            // Extract forecast value based on metric
            if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
                const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                if (high !== null && market.threshold !== undefined) {
                    forecastValue = high;

                    let thresholdF = market.threshold;
                    if (market.thresholdUnit === 'C') {
                        thresholdF = (market.threshold * 9 / 5) + 32;
                    }

                    probability = this.weatherService.calculateTempExceedsProbability(high, thresholdF);
                    if (market.comparisonType === 'below') probability = 1 - probability;
                    hasValidForecast = true;
                }
            } else if (market.metricType === 'temperature_low') {
                const low = WeatherService.calculateLow(weatherData, market.targetDate);
                if (low !== null && market.threshold !== undefined) {
                    forecastValue = low;

                    let thresholdF = market.threshold;
                    if (market.thresholdUnit === 'C') {
                        thresholdF = (market.threshold * 9 / 5) + 32;
                    }

                    probability = this.weatherService.calculateTempExceedsProbability(low, thresholdF);
                    if (market.comparisonType === 'below') probability = 1 - probability;
                    hasValidForecast = true;
                }
            } else if (market.metricType === 'temperature_range') {
                const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                if (high !== null && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
                    forecastValue = high;

                    let minF = market.minThreshold;
                    let maxF = market.maxThreshold;
                    if (market.thresholdUnit === 'C') {
                        minF = (market.minThreshold * 9 / 5) + 32;
                        maxF = (market.maxThreshold * 9 / 5) + 32;
                    }

                    const probAboveMin = this.weatherService.calculateTempExceedsProbability(high, minF);
                    const probAboveMax = this.weatherService.calculateTempExceedsProbability(high, maxF);
                    probability = Math.max(0, Math.min(1, probAboveMin - probAboveMax));
                    hasValidForecast = true;
                }
            } else if (market.metricType === 'precipitation') {
                const targetDateObj = new Date(market.targetDate);
                targetDateObj.setUTCHours(0, 0, 0, 0);

                const dayForecasts = weatherData.hourly.filter((h: { timestamp: Date }) => {
                    const hourDate = new Date(h.timestamp);
                    hourDate.setUTCHours(0, 0, 0, 0);
                    return hourDate.getTime() === targetDateObj.getTime();
                });

                if (dayForecasts.length > 0) {
                    const maxPrecipProb = Math.max(...dayForecasts.map((h: { probabilityOfPrecipitation: number }) => h.probabilityOfPrecipitation));
                    forecastValue = maxPrecipProb;
                    probability = maxPrecipProb / 100;
                    if (market.comparisonType === 'below') probability = 1 - probability;
                    hasValidForecast = true;
                }
            }

            if (!hasValidForecast) continue;

            const currentState = this.store.getMarketState(market.market.id);
            const previousValue = currentState?.lastForecast?.forecastValue;
            const previousSource = currentState?.lastForecast?.weatherData?.source;
            const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

            const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

            let significantChangeThreshold: number;
            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_low':
                case 'temperature_threshold':
                case 'temperature_range':
                    significantChangeThreshold = 1;
                    break;
                default:
                    significantChangeThreshold = 1;
            }

            const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
            const valueChanged = !sourceChanged && changeAmount >= significantChangeThreshold;

            const now = new Date();
            const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

            const isNew = !this.initializedMarkets.has(market.market.id);
            if (isNew) {
                this.initializedMarkets.add(market.market.id);
            }

            const realChange = valueChanged && !isNew;

            if (realChange) {
                logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`);

                if (this.onForecastChanged) {
                    this.onForecastChanged(market.market.id, changeAmount);
                }
            }

            const snapshot: ForecastSnapshot = {
                marketId: market.market.id,
                weatherData,
                forecastValue,
                probability,
                timestamp: now,
                previousValue,
                valueChanged: realChange,
                changeAmount,
                changeTimestamp,
            };

            this.store.updateForecast(market.market.id, snapshot);
        }
    }
}