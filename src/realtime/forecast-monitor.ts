/**
 * Forecast Monitor
 * Reacts to FILE_CONFIRMED events from file-based ingestion and updates DataStore
 * 
 * File-based Integration:
 * - Listens for FILE_CONFIRMED events from file-based ingestion
 * - Converts GRIB data to weather format for market processing
 * - Uses state machine to track FETCH_MODE for cities
 */

import { WeatherService } from '../weather/index.js';
import type { WeatherData, CityGRIBData } from '../weather/types.js';
import { DataStore } from './data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { ForecastSnapshot, ThresholdPosition } from './types.js';
import { logger, rateLimitedLogger } from '../logger.js';
import { config } from '../config.js';
import { eventBus, FetchModeEnterEvent, FetchModeExitEvent, FileConfirmedEvent } from './event-bus.js';
import { ForecastStateMachine, forecastStateMachine } from './forecast-state-machine.js';

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private regularPollIntervalMs: number;
    private isRunning: boolean = false;
    private regularPollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();
    public cacheTtlMs: number = 120000; // 2 minutes default cache TTL
    private initializedMarkets: Set<string> = new Set();

    // Callback for significant changes
    public onForecastChanged: ((marketId: string, changeAmount: number) => void) | null = null;

    // Webhook integration components
    private stateMachine: ForecastStateMachine;
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
        // Listen for FILE_CONFIRMED events from file-based ingestion
        const unsubscribeFileConfirmed = eventBus.on('FILE_CONFIRMED', (event: FileConfirmedEvent) => {
            this.handleFileConfirmed(event);
        });
        this.eventBusUnsubscribers.push(unsubscribeFileConfirmed);

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
        // Webhook components initialized via event bus only
    }

    /**
     * Handle FILE_CONFIRMED event from file-based ingestion
     */
    private async handleFileConfirmed(event: FileConfirmedEvent): Promise<void> {
        const { model, cycleHour, cityData, timestamp } = event.payload;
        
        logger.info(`📦 File confirmed: ${model} cycle ${cycleHour}`, {
            cityCount: cityData.length,
            timestamp: timestamp.toISOString(),
        });

        for (const cityGRIBData of cityData) {
            await this.processCityGRIBData(cityGRIBData);
        }
    }

    /**
     * Process city data from GRIB file
     */
    private async processCityGRIBData(cityData: CityGRIBData): Promise<void> {
        const markets = this.store.getAllMarkets();
        const cityMarkets = markets.filter(m => 
            m.city?.toLowerCase().replace(/\s+/g, '_') === cityData.cityName.toLowerCase().replace(/\s+/g, '_')
        );

        if (cityMarkets.length === 0) {
            return;
        }

        const weatherData = this.convertGRIBToWeatherData(cityData);
        await this.processCityMarkets(cityData.cityName, cityMarkets, weatherData);
    }

    /**
     * Convert CityGRIBData to WeatherData format for processing
     */
    private convertGRIBToWeatherData(cityData: CityGRIBData): WeatherData {
        const hourly = cityData.hourlyTempsF.map((tempF, i) => ({
            timestamp: new Date(Date.now() + i * 3600000),
            temperatureF: tempF,
            temperatureC: (tempF - 32) * 5 / 9,
            humidity: 50,
            windSpeedMph: cityData.windSpeedMph,
            probabilityOfPrecipitation: cityData.precipitationRateMmHr > 0 ? 80 : 20,
            isDaytime: true,
        }));

        return {
            location: cityData.coordinates,
            source: 'file',
            fetchedAt: new Date(),
            hourly,
            daily: [{
                date: new Date(),
                highF: cityData.dailyHighF ?? cityData.temperatureF,
                lowF: cityData.dailyLowF ?? cityData.temperatureF,
                highC: ((cityData.dailyHighF ?? cityData.temperatureF) - 32) * 5 / 9,
                lowC: ((cityData.dailyLowF ?? cityData.temperatureF) - 32) * 5 / 9,
                probabilityOfPrecipitation: cityData.totalPrecipitationMm > 0 ? 80 : 20,
            }],
        };
    }

    /**
     * Handle FETCH_MODE_ENTER event
     */
    private handleFetchModeEnter(event: FetchModeEnterEvent): void {
        const { cityId, reason } = event.payload;
        
        logger.debug(`Fetch mode entered for ${cityId}`, { reason });
    }

    /**
     * Handle FETCH_MODE_EXIT event
     */
    private handleFetchModeExit(event: FetchModeExitEvent): void {
        const { cityId, reason } = event.payload;
        
        logger.debug(`Fetch mode exited for ${cityId}`, { reason });
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        
        if (this.useWebhookMode) {
            // Still run regular polling as a fallback
            this.scheduleRegularPoll();
            
            logger.info('ForecastMonitor started in webhook mode');
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
     * Poll all cities - No-op in file-based mode
     * The monitor only reacts to FILE_CONFIRMED events
     */
    private async pollRegular(): Promise<void> {
        if (!this.isRunning) return;

        // File-based mode: no active polling, just reschedule
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

    /**
     * Process markets for a city using already-fetched weather data.
     * Shared logic for both individual and batch fetch paths (Q1: DRY).
     */
    private async processCityMarkets(city: string, markets: ParsedWeatherMarket[], weatherData: WeatherData): Promise<void> {
        for (const market of markets) {
            if (!market.targetDate) continue;

            const extracted = this.extractForecastValue(market, weatherData);
            if (!extracted) continue;

            const { forecastValue, probability } = extracted;

            const currentState = this.store.getMarketState(market.market.id);
            const previousValue = currentState?.lastForecast?.forecastValue;
            const previousSource = currentState?.lastForecast?.weatherData?.source;
            const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;
            const previousThresholdPosition = currentState?.lastForecast?.thresholdPosition;

            const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;
            const significantChangeThreshold = 1;

            const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
            // Value change is detected regardless of source change - the forecast value matters, not where it came from
            const valueChanged = changeAmount >= significantChangeThreshold;

            const now = new Date();
            const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

            const isNew = !this.initializedMarkets.has(market.market.id);
            if (isNew) {
                this.initializedMarkets.add(market.market.id);
            }

            const realChange = valueChanged && !isNew;

            if (realChange) {
                // Use rate-limited logger to prevent spam when many cities change
                rateLimitedLogger.info(
                    `forecast-change:${city}`,
                    `⚡ FORECAST CHANGED for ${city} (${market.metricType})`,
                    { changeAmount }
                );

                if (this.onForecastChanged) {
                    this.onForecastChanged(market.market.id, changeAmount);
                }
            }

            // Calculate threshold position for speed arbitrage
            let thresholdPosition: ThresholdPosition | undefined;
            if (market.threshold !== undefined) {
                thresholdPosition = this.calculateThresholdPosition(
                    forecastValue,
                    market.threshold,
                    market.thresholdUnit,
                    market.comparisonType
                );
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
                // Threshold crossing detection fields
                thresholdPosition,
                previousThresholdPosition,
            };

            this.store.updateForecast(market.market.id, snapshot);
        }
    }

    /**
     * Extract forecast value and probability from weather data for a market.
     * Q1: Shared helper to eliminate duplication between update paths.
     */
    private extractForecastValue(
        market: ParsedWeatherMarket,
        weatherData: WeatherData
    ): { forecastValue: number; probability: number } | null {
        if (!market.targetDate) return null;

        if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
            const high = WeatherService.calculateHigh(weatherData, market.targetDate);
            if (high !== null && market.threshold !== undefined) {
                let thresholdF = market.threshold;
                if (market.thresholdUnit === 'C') {
                    thresholdF = (market.threshold * 9 / 5) + 32;
                }
                let probability = this.weatherService.calculateTempExceedsProbability(high, thresholdF);
                if (market.comparisonType === 'below') probability = 1 - probability;
                return { forecastValue: high, probability };
            }
        } else if (market.metricType === 'temperature_low') {
            const low = WeatherService.calculateLow(weatherData, market.targetDate);
            if (low !== null && market.threshold !== undefined) {
                let thresholdF = market.threshold;
                if (market.thresholdUnit === 'C') {
                    thresholdF = (market.threshold * 9 / 5) + 32;
                }
                let probability = this.weatherService.calculateTempExceedsProbability(low, thresholdF);
                if (market.comparisonType === 'below') probability = 1 - probability;
                return { forecastValue: low, probability };
            }
        } else if (market.metricType === 'temperature_range') {
            const high = WeatherService.calculateHigh(weatherData, market.targetDate);
            if (high !== null && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
                let minF = market.minThreshold;
                let maxF = market.maxThreshold;
                if (market.thresholdUnit === 'C') {
                    minF = (market.minThreshold * 9 / 5) + 32;
                    maxF = (market.maxThreshold * 9 / 5) + 32;
                }
                const probAboveMin = this.weatherService.calculateTempExceedsProbability(high, minF);
                const probAboveMax = this.weatherService.calculateTempExceedsProbability(high, maxF);
                const probability = Math.max(0, Math.min(1, probAboveMin - probAboveMax));
                return { forecastValue: high, probability };
            }
        } else if (market.metricType === 'precipitation') {
            const targetDateObj = new Date(market.targetDate);
            targetDateObj.setUTCHours(0, 0, 0, 0);
            const targetDateStr = targetDateObj.toISOString().split('T')[0];

            const dayForecasts = weatherData.hourly.filter((h: { timestamp: Date }) => {
                const hourDate = new Date(h.timestamp);
                // Use date string comparison to avoid timestamp mismatch issues
                return hourDate.toISOString().split('T')[0] === targetDateStr;
            });

            if (dayForecasts.length > 0) {
                const maxPrecipProb = Math.max(
                    ...dayForecasts.map((h: { probabilityOfPrecipitation: number }) => h.probabilityOfPrecipitation)
                );
                let probability = maxPrecipProb / 100;
                if (market.comparisonType === 'below') probability = 1 - probability;
                return { forecastValue: maxPrecipProb, probability };
            }
        }

        return null;
    }

    /**
     * Calculate threshold position for speed arbitrage threshold-crossing detection.
     * Returns the position relative to the market's threshold.
     */
    calculateThresholdPosition(
        forecastValue: number,
        threshold: number,
        thresholdUnit: string | undefined,
        comparisonType: string | undefined
    ): ThresholdPosition {
        // Convert threshold to Fahrenheit if needed
        let thresholdF = threshold;
        if (thresholdUnit === 'C') {
            thresholdF = (threshold * 9 / 5) + 32;
        }

        const distance = forecastValue - thresholdF;
        const now = new Date();

        return {
            relativeToThreshold: distance > 0.5 ? 'above' : distance < -0.5 ? 'below' : 'at',
            distanceFromThreshold: Math.abs(distance),
            timestamp: now,
        };
    }

    /**
     * Detect if a threshold crossing occurred between previous and current positions.
     * Used by speed arbitrage to determine if a trade should be generated.
     */
    detectThresholdCrossing(
        previous: ThresholdPosition | undefined,
        current: ThresholdPosition,
        minCrossingDistance: number = 0.5
    ): { crossed: boolean; direction: 'up' | 'down' | 'none' } {
        // No previous position - this is first data, not a crossing
        if (!previous) {
            return { crossed: false, direction: 'none' };
        }

        // Same side of threshold - no crossing
        if (previous.relativeToThreshold === current.relativeToThreshold) {
            return { crossed: false, direction: 'none' };
        }

        // Check if the crossing is significant enough (not just noise near threshold)
        // At least one position should be sufficiently far from threshold
        const hasSufficientDistance = 
            previous.distanceFromThreshold >= minCrossingDistance ||
            current.distanceFromThreshold >= minCrossingDistance;

        if (!hasSufficientDistance) {
            return { crossed: false, direction: 'none' };
        }

        // Determine direction
        const crossedUp = previous.relativeToThreshold === 'below' && 
                          current.relativeToThreshold === 'above';
        const crossedDown = previous.relativeToThreshold === 'above' && 
                            current.relativeToThreshold === 'below';

        return {
            crossed: crossedUp || crossedDown,
            direction: crossedUp ? 'up' : crossedDown ? 'down' : 'none',
        };
    }
}
