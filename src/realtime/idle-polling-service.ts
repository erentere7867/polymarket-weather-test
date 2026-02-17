/**
 * Idle Polling Service
 * Fallback polling service for IDLE mode
 * - Low-frequency round-robin polling every 5 minutes
 * - Polls all providers except Tomorrow.io (webhook-driven)
 * - Protects against missed webhook deliveries
 * - Stops when entering FETCH_MODE for a city
 */

import { ForecastStateMachine } from './forecast-state-machine.js';
import { eventBus } from './event-bus.js';
import { WeatherProviderManager } from '../weather/provider-manager.js';
import { WeatherService } from '../weather/index.js';
import { IWeatherProvider, findCity, CityLocation, WeatherData } from '../weather/types.js';
import { DataStore } from './data-store.js';
import { ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Idle Polling Service
 */
export class IdlePollingService {
    private stateMachine: ForecastStateMachine;
    private providerManager: WeatherProviderManager;
    private weatherService: WeatherService;
    private dataStore: DataStore;
    private readonly pollIntervalMs: number;

    // Global polling interval
    private pollTimeoutId: NodeJS.Timeout | null = null;

    // Track if service is running
    private isRunning: boolean = false;

    // Track if service is disposed
    private isDisposed: boolean = false;

    // Track last poll time per city
    private lastPollTime: Map<string, Date> = new Map();

    // Track last forecast data per city for change detection
    private lastForecastData: Map<string, WeatherData> = new Map();

    // Track initialized markets (first value should not trigger change)
    private initializedMarkets: Set<string> = new Set();

    // Minimum time between polls for the same city
    private readonly minPollIntervalMs: number = 60000; // 1 minute minimum

    constructor(
        stateMachine: ForecastStateMachine,
        dataStore: DataStore,
        providerManager?: WeatherProviderManager,
        weatherService?: WeatherService
    ) {
        this.stateMachine = stateMachine;
        this.dataStore = dataStore;
        this.providerManager = providerManager || new WeatherProviderManager();
        this.weatherService = weatherService || new WeatherService();
        this.pollIntervalMs = (config.IDLE_POLL_INTERVAL_MINUTES || 5) * 60 * 1000;

        logger.info('IdlePollingService initialized', {
            pollIntervalMinutes: this.pollIntervalMs / 60000,
        });
    }

    /**
     * Start the idle polling service
     */
    start(): void {
        if (this.isRunning || this.isDisposed) {
            return;
        }

        this.isRunning = true;
        logger.info('IdlePollingService started');

        // Schedule first poll
        this.scheduleNextPoll();
    }

    /**
     * Stop the idle polling service
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        if (this.pollTimeoutId) {
            clearTimeout(this.pollTimeoutId);
            this.pollTimeoutId = null;
        }

        logger.info('IdlePollingService stopped');
    }

    /**
     * Schedule the next poll
     */
    private scheduleNextPoll(): void {
        if (!this.isRunning || this.isDisposed) {
            return;
        }

        this.pollTimeoutId = setTimeout(() => {
            this.runPollCycle();
        }, this.pollIntervalMs);
    }

    /**
     * Run a complete poll cycle
     */
    private async runPollCycle(): Promise<void> {
        if (!this.isRunning || this.isDisposed) {
            return;
        }

        try {
            await this.pollAllCities();
        } catch (error) {
            logger.error('Error in idle poll cycle', { error: (error as Error).message });
        }

        // Schedule next poll
        this.scheduleNextPoll();
    }

    /**
     * Poll all cities that are in IDLE mode
     */
    private async pollAllCities(): Promise<void> {
        // Get all cities from data store markets
        const cities = this.getAllCities();

        if (cities.length === 0) {
            logger.debug('No cities to poll in IDLE mode');
            return;
        }

        logger.debug(`Idle polling ${cities.length} cities`);

        // Poll each city that's in IDLE mode
        for (const cityId of cities) {
            // Skip if no longer running
            if (!this.isRunning) break;

            // Skip cities in FETCH_MODE
            if (this.stateMachine.isInFetchMode(cityId)) {
                logger.debug(`Skipping ${cityId}: in FETCH_MODE`);
                continue;
            }

            // Check if we've polled this city recently
            const lastPoll = this.lastPollTime.get(cityId);
            if (lastPoll && Date.now() - lastPoll.getTime() < this.minPollIntervalMs) {
                logger.debug(`Skipping ${cityId}: polled recently`);
                continue;
            }

            try {
                await this.pollCity(cityId);
                this.lastPollTime.set(cityId, new Date());
            } catch (error) {
                logger.warn(`Failed to poll ${cityId} in IDLE mode`, {
                    error: (error as Error).message,
                });
            }

            // Small delay between cities to avoid rate limiting
            await this.sleep(500);
        }
    }

    /**
     * Poll a single city
     */
    private async pollCity(cityId: string): Promise<void> {
        const city = this.resolveCity(cityId);
        if (!city) {
            logger.warn(`Cannot poll unknown city: ${cityId}`);
            return;
        }

        // Get secondary providers (exclude Tomorrow.io)
        const providers = this.getSecondaryProviders();

        if (providers.length === 0) {
            logger.warn('No secondary providers available for idle polling');
            return;
        }

        // Try each provider until one succeeds
        for (const provider of providers) {
            try {
                // Wait for rate limit
                await this.providerManager.waitForRateLimit(provider.name);
                await this.providerManager.enforceRateLimit(provider.name);

                logger.debug(`Idle polling ${cityId} from ${provider.name}`);

                const startTime = Date.now();
                const data = await provider.getHourlyForecast(city.coordinates);
                const duration = Date.now() - startTime;

                // Record success
                this.providerManager.recordSuccess(provider.name);

                logger.debug(`Idle poll success for ${cityId} from ${provider.name}`, {
                    durationMs: duration,
                });

                // Store the forecast data (this will trigger normal processing)
                await this.storeForecastData(cityId, data);

                // Success - no need to try other providers
                return;
            } catch (error) {
                const statusCode = (error as any)?.response?.status;
                this.providerManager.recordError(provider.name, statusCode);

                logger.debug(`Idle poll failed for ${cityId} from ${provider.name}`, {
                    error: (error as Error).message,
                });

                // Continue to next provider
            }
        }

        logger.warn(`All providers failed for idle poll of ${cityId}`);
    }

    /**
     * Store forecast data and trigger normal processing
     */
    private async storeForecastData(cityId: string, data: WeatherData): Promise<void> {
        // Get markets for this city
        const markets = this.getMarketsForCity(cityId);

        if (markets.length === 0) {
            logger.debug(`No markets found for city ${cityId}`);
            return;
        }

        // Get previous data for change detection
        const previousData = this.lastForecastData.get(cityId);
        this.lastForecastData.set(cityId, data);

        // Detect if forecast changed
        const hasChanged = this.hasForecastChanged(previousData, data);
        let changeAmount = 0;
        let previousValue: number | undefined;
        const newValue = data.hourly[0]?.temperatureF;

        if (previousData && previousData.hourly.length > 0 && data.hourly.length > 0) {
            previousValue = previousData.hourly[0].temperatureF;
            changeAmount = Math.abs(newValue - previousValue);
        }

        for (const market of markets) {
            if (!market.targetDate) continue;

            // Calculate forecast value and probability
            let forecastValue = 0;
            let probability = 0;
            let hasValidForecast = false;

            if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
                const high = WeatherService.calculateHigh(data, market.targetDate);
                logger.info(`[IDLE POLL] ${cityId} ${market.metricType}: high=${high}°F, targetDate=${market.targetDate?.toISOString()}, source=${data.source}`);
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
                const low = WeatherService.calculateLow(data, market.targetDate);
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
            } else if (market.metricType === 'precipitation') {
                const targetDateObj = new Date(market.targetDate);
                targetDateObj.setUTCHours(0, 0, 0, 0);
                const targetDateStr = targetDateObj.toISOString().split('T')[0];
                const dayForecasts = data.hourly.filter((h: { timestamp: Date }) => {
                    const hourDate = new Date(h.timestamp);
                    // Use date string comparison to avoid timestamp mismatch issues
                    return hourDate.toISOString().split('T')[0] === targetDateStr;
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

            // Check if this is the first time we're seeing this market
            const isNew = !this.initializedMarkets.has(market.market.id);
            if (isNew) {
                this.initializedMarkets.add(market.market.id);
            }

            // Only emit change if not initial value
            const realChange = hasChanged && !isNew;

            const now = new Date();
            const snapshot: ForecastSnapshot = {
                marketId: market.market.id,
                weatherData: data,
                forecastValue,
                probability,
                timestamp: now,
                previousValue,
                valueChanged: realChange,
                changeAmount,
                changeTimestamp: now,
            };

            // Update the data store
            this.dataStore.updateForecast(market.market.id, snapshot);

            if (realChange) {
                logger.info(`⚡ IDLE POLL: Forecast changed for ${cityId} (${market.metricType})`);
            }
        }

        // Emit FORECAST_CHANGED event if there was a real change (not first poll)
        if (hasChanged && previousData) {
            eventBus.emit({
                type: 'FORECAST_CHANGED',
                payload: {
                    cityId,
                    provider: data.source,
                    previousValue,
                    newValue,
                    changeAmount,
                    timestamp: new Date(),
                    source: 'IDLE_POLL',
                    confidence: 0.8,
                },
            });

            logger.info(`📊 IDLE POLL: Emitted FORECAST_CHANGED for ${cityId}`, {
                changeAmount: changeAmount.toFixed(1),
            });
        }
    }

    /**
     * Compare two forecast data objects for significant changes
     */
    private hasForecastChanged(oldData: WeatherData | undefined, newData: WeatherData): boolean {
        if (!oldData) {
            return false; // First fetch, not a "change"
        }

        // Compare fetchedAt timestamps
        if (oldData.fetchedAt.getTime() !== newData.fetchedAt.getTime()) {
            return true;
        }

        // Compare hourly forecast counts
        if (oldData.hourly.length !== newData.hourly.length) {
            return true;
        }

        // Compare first few hours for significant changes (temperature threshold: 0.5°F)
        const hoursToCompare = Math.min(24, oldData.hourly.length, newData.hourly.length);
        for (let i = 0; i < hoursToCompare; i++) {
            const oldHour = oldData.hourly[i];
            const newHour = newData.hourly[i];

            if (Math.abs(oldHour.temperatureF - newHour.temperatureF) >= 0.5) {
                return true;
            }

            if (oldHour.probabilityOfPrecipitation !== newHour.probabilityOfPrecipitation) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get all cities from tracked markets
     */
    private getAllCities(): string[] {
        const cities = new Set<string>();
        const markets = this.dataStore.getAllMarkets();

        for (const market of markets) {
            if (market.city) {
                const normalizedCity = market.city.toLowerCase().replace(/\s+/g, '_');
                cities.add(normalizedCity);
            }
        }

        return Array.from(cities);
    }

    /**
     * Get markets for a specific city
     */
    private getMarketsForCity(cityId: string): any[] {
        const markets = this.dataStore.getAllMarkets();
        const normalizedCityId = cityId.toLowerCase();

        return markets.filter(market => {
            if (!market.city) return false;
            const normalizedMarketCity = market.city.toLowerCase().replace(/\s+/g, '_');
            return normalizedMarketCity === normalizedCityId;
        });
    }

    /**
     * Get secondary providers (all except Tomorrow.io)
     */
    private getSecondaryProviders(): IWeatherProvider[] {
        const providers: IWeatherProvider[] = [];
        const providerCount = this.providerManager.getProviderCount();

        for (let i = 0; i < providerCount; i++) {
            try {
                const provider = this.providerManager.getProvider(undefined, i, true);
                if (provider && provider.name !== 'tomorrow') {
                    providers.push(provider);
                }
            } catch {
                // Provider not available, skip
            }
        }

        return providers;
    }

    /**
     * Resolve city ID to CityLocation
     */
    private resolveCity(cityId: string): CityLocation | null {
        // Try direct lookup first
        let city = findCity(cityId);
        if (city) return city;

        // Try with underscores replaced by spaces
        city = findCity(cityId.replace(/_/g, ' '));
        if (city) return city;

        // Try common variations
        const normalizedId = cityId.toLowerCase();
        for (const knownCity of [
            'New York City', 'Washington DC', 'Chicago', 'Los Angeles',
            'Miami', 'Dallas', 'Seattle', 'Atlanta', 'Toronto',
            'London', 'Seoul', 'Ankara', 'Buenos Aires'
        ]) {
            const normalizedName = knownCity.toLowerCase().replace(/\s+/g, '_');
            if (normalizedId === normalizedName) {
                return findCity(knownCity) || null;
            }
        }

        return null;
    }

    /**
     * Sleep utility
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if the service is currently running
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Get statistics about the service
     */
    getStats(): {
        isRunning: boolean;
        pollIntervalMinutes: number;
        citiesPolled: number;
        lastPollTimes: Record<string, string>;
    } {
        const lastPollTimes: Record<string, string> = {};
        for (const [cityId, time] of this.lastPollTime.entries()) {
            lastPollTimes[cityId] = time.toISOString();
        }

        return {
            isRunning: this.isRunning,
            pollIntervalMinutes: this.pollIntervalMs / 60000,
            citiesPolled: this.lastPollTime.size,
            lastPollTimes,
        };
    }

    /**
     * Dispose of the service and clean up resources
     */
    dispose(): void {
        this.isDisposed = true;
        this.stop();
        this.lastPollTime.clear();
        logger.info('IdlePollingService disposed');
    }
}
