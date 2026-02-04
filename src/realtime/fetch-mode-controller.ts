/**
 * Fetch Mode Controller
 * Manages active forecast fetching during FETCH_MODE
 * - Immediately fetches Tomorrow.io on enter
 * - Round-robin polls secondary providers every 5 seconds
 * - Tracks provider errors and disables after 3 consecutive failures
 * - Detects forecast changes using provider timestamps
 * - Exits FETCH_MODE when no changes for 5 minutes or 10-minute timeout
 */

import { ForecastStateMachine, StateContext } from './forecast-state-machine.js';
import { eventBus } from './event-bus.js';
import { WeatherProviderManager } from '../weather/provider-manager.js';
import { WeatherService } from '../weather/index.js';
import { IWeatherProvider, WeatherData, findCity, CityLocation } from '../weather/types.js';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Provider fetch result
 */
interface ProviderFetchResult {
    provider: string;
    success: boolean;
    hasChanges: boolean;
    data?: WeatherData;
    error?: string;
}

/**
 * Fetch Mode Controller
 */
export class FetchModeController {
    private stateMachine: ForecastStateMachine;
    private providerManager: WeatherProviderManager;
    private weatherService: WeatherService;
    private dataStore: DataStore;
    private readonly pollIntervalMs: number;
    private readonly maxProviderErrors: number = 3;

    // Track active polling intervals per city
    private activePollers: Map<string, NodeJS.Timeout> = new Map();

    // Track last forecast data per city for change detection
    private lastForecastData: Map<string, Map<string, WeatherData>> = new Map();

    // Track if controller is disposed
    private isDisposed: boolean = false;

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
        this.pollIntervalMs = config.PROVIDER_POLL_INTERVAL_MS || 5000;

        // Listen for state machine events
        this.setupEventListeners();

        logger.info('FetchModeController initialized', {
            pollIntervalMs: this.pollIntervalMs,
            maxProviderErrors: this.maxProviderErrors,
        });
    }

    /**
     * Setup event listeners for state machine
     */
    private setupEventListeners(): void {
        // Listen for FETCH_MODE_ENTER events
        this.stateMachine.on('transition', (transition) => {
            if (transition.to === 'FETCH_MODE') {
                this.onEnterFetchMode(transition.cityId);
            } else if (transition.from === 'FETCH_MODE' && transition.to === 'IDLE') {
                this.onExitFetchMode(transition.cityId);
            }
        });
    }

    /**
     * Handle entering FETCH_MODE for a city
     */
    private async onEnterFetchMode(cityId: string): Promise<void> {
        if (this.isDisposed) return;

        logger.info(`🚀 Entering FETCH_MODE for ${cityId}`);

        // Immediately fetch Tomorrow.io forecast
        await this.fetchTomorrowIo(cityId);

        // Start round-robin polling of other providers
        this.startPolling(cityId);
    }

    /**
     * Handle exiting FETCH_MODE for a city
     */
    private onExitFetchMode(cityId: string): void {
        logger.info(`🛑 Exiting FETCH_MODE for ${cityId}`);

        // Stop polling
        this.stopPolling(cityId);

        // Clean up forecast data
        this.lastForecastData.delete(cityId);
    }

    /**
     * Fetch Tomorrow.io forecast immediately
     */
    private async fetchTomorrowIo(cityId: string): Promise<void> {
        try {
            const city = this.resolveCity(cityId);
            if (!city) {
                logger.warn(`Cannot fetch Tomorrow.io: unknown city ${cityId}`);
                return;
            }

            // Get Tomorrow.io provider
            const tomorrowProvider = this.getTomorrowProvider();
            if (!tomorrowProvider) {
                logger.warn('Tomorrow.io provider not available');
                return;
            }

            logger.debug(`Fetching Tomorrow.io for ${cityId}`);

            const startTime = Date.now();
            const data = await tomorrowProvider.getHourlyForecast(city.coordinates);
            const duration = Date.now() - startTime;

            // Record success
            this.stateMachine.recordProviderFetch(cityId, 'tomorrow', true);

            // Check for changes (returns previous data for proper event emission)
            const { hasChanged, previousData } = this.detectChanges(cityId, 'tomorrow', data);

            // Emit provider fetch event
            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: 'tomorrow',
                    success: true,
                    hasChanges: hasChanged,
                },
            });

            // If changes detected, reset no-change timeout
            if (hasChanged) {
                this.stateMachine.resetNoChangeTimeout(cityId);
                this.emitForecastChanged(cityId, 'tomorrow', data, previousData);
            }

            logger.debug(`Tomorrow.io fetch completed for ${cityId}`, {
                durationMs: duration,
                hasChanges: hasChanged,
            });
        } catch (error) {
            const errorMsg = (error as Error).message;
            logger.error(`Tomorrow.io fetch failed for ${cityId}`, { error: errorMsg });

            this.stateMachine.recordProviderFetch(cityId, 'tomorrow', false);

            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: 'tomorrow',
                    success: false,
                    hasChanges: false,
                    error: errorMsg,
                },
            });
        }
    }

    /**
     * Start round-robin polling for a city
     */
    private startPolling(cityId: string): void {
        // Stop any existing polling
        this.stopPolling(cityId);

        logger.debug(`Starting provider polling for ${cityId}`);

        // Start polling loop
        const poll = async () => {
            if (this.isDisposed) return;

            // Check if still in FETCH_MODE
            if (!this.stateMachine.isInFetchMode(cityId)) {
                logger.debug(`Stopping polling for ${cityId}: no longer in FETCH_MODE`);
                return;
            }

            await this.pollProvidersRoundRobin(cityId);

            // Schedule next poll if still in FETCH_MODE
            if (this.stateMachine.isInFetchMode(cityId)) {
                const timeoutId = setTimeout(poll, this.pollIntervalMs);
                this.activePollers.set(cityId, timeoutId);
            }
        };

        // Start first poll
        poll();
    }

    /**
     * Stop polling for a city
     */
    private stopPolling(cityId: string): void {
        const timeoutId = this.activePollers.get(cityId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.activePollers.delete(cityId);
            logger.debug(`Stopped polling for ${cityId}`);
        }
    }

    /**
     * Poll providers in round-robin fashion
     */
    private async pollProvidersRoundRobin(cityId: string): Promise<void> {
        const city = this.resolveCity(cityId);
        if (!city) {
            logger.warn(`Cannot poll providers: unknown city ${cityId}`);
            return;
        }

        // Get all providers except Tomorrow.io (already fetched immediately)
        const providers = this.getSecondaryProviders(cityId);

        for (const provider of providers) {
            // Check if still in FETCH_MODE
            if (!this.stateMachine.isInFetchMode(cityId)) {
                break;
            }

            // Skip if provider has too many errors
            if (this.stateMachine.shouldSkipProvider(cityId, provider.name, this.maxProviderErrors)) {
                logger.debug(`Skipping ${provider.name} for ${cityId}: too many errors`);
                continue;
            }

            await this.fetchFromProvider(cityId, city, provider);

            // Small delay between providers
            if (providers.indexOf(provider) < providers.length - 1) {
                await this.sleep(100);
            }
        }
    }

    /**
     * Fetch forecast from a specific provider
     */
    private async fetchFromProvider(
        cityId: string,
        city: CityLocation,
        provider: IWeatherProvider
    ): Promise<ProviderFetchResult> {
        const startTime = Date.now();

        try {
            // Wait for rate limit if needed
            await this.providerManager.waitForRateLimit(provider.name);
            await this.providerManager.enforceRateLimit(provider.name);

            const data = await provider.getHourlyForecast(city.coordinates);
            const duration = Date.now() - startTime;

            // Record success
            this.stateMachine.recordProviderFetch(cityId, provider.name, true);
            this.providerManager.recordSuccess(provider.name);

            // Check for changes (returns previous data for proper event emission)
            const { hasChanged, previousData } = this.detectChanges(cityId, provider.name, data);

            // Emit provider fetch event
            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: provider.name,
                    success: true,
                    hasChanges: hasChanged,
                },
            });

            // If changes detected, reset no-change timeout and emit forecast changed
            if (hasChanged) {
                this.stateMachine.resetNoChangeTimeout(cityId);
                this.emitForecastChanged(cityId, provider.name, data, previousData);
            }

            logger.debug(`Provider fetch success: ${provider.name} for ${cityId}`, {
                durationMs: duration,
                hasChanges: hasChanged,
            });

            return {
                provider: provider.name,
                success: true,
                hasChanges: hasChanged,
                data,
            };
        } catch (error) {
            const errorMsg = (error as Error).message;
            const duration = Date.now() - startTime;

            // Record error
            this.stateMachine.recordProviderFetch(cityId, provider.name, false);

            const statusCode = (error as any)?.response?.status;
            this.providerManager.recordError(provider.name, statusCode);

            // Check if provider should be disabled
            const errorCount = this.stateMachine.getProviderErrorCount(cityId, provider.name);
            if (errorCount >= this.maxProviderErrors) {
                logger.warn(`Provider ${provider.name} disabled for ${cityId} after ${errorCount} errors`);
            }

            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: provider.name,
                    success: false,
                    hasChanges: false,
                    error: errorMsg,
                },
            });

            logger.debug(`Provider fetch failed: ${provider.name} for ${cityId}`, {
                durationMs: duration,
                error: errorMsg,
            });

            return {
                provider: provider.name,
                success: false,
                hasChanges: false,
                error: errorMsg,
            };
        }
    }

    /**
     * Detect if forecast data has changed and return previous data for emission
     * @returns Object with hasChanged flag and previousData for proper event emission
     */
    private detectChanges(cityId: string, providerName: string, newData: WeatherData): { hasChanged: boolean; previousData: WeatherData | undefined } {
        let providerData = this.lastForecastData.get(cityId);
        if (!providerData) {
            providerData = new Map();
            this.lastForecastData.set(cityId, providerData);
        }

        const lastData = providerData.get(providerName);
        if (!lastData) {
            // First fetch from this provider
            providerData.set(providerName, newData);
            return { hasChanged: false, previousData: undefined };
        }

        // Compare timestamps to detect changes
        // Providers typically update their 'fetchedAt' or have internal timestamps
        const hasChanged = this.hasForecastChanged(lastData, newData);

        // Capture previous data BEFORE storing new data (fixes change detection bug)
        const previousData = lastData;

        // Store new data
        providerData.set(providerName, newData);

        return { hasChanged, previousData };
    }

    /**
     * Compare two forecast data objects for significant changes
     */
    private hasForecastChanged(oldData: WeatherData, newData: WeatherData): boolean {
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
     * Emit FORECAST_CHANGED event
     * @param previousData - The previous forecast data (passed in before storing new data to avoid race condition)
     */
    private emitForecastChanged(cityId: string, provider: string, newData: WeatherData, previousData: WeatherData | undefined): void {
        let changeAmount = 0;
        let previousValue: number | undefined;
        const newValue = newData.hourly[0]?.temperatureF;

        if (previousData && previousData.hourly.length > 0 && newData.hourly.length > 0) {
            previousValue = previousData.hourly[0].temperatureF;
            changeAmount = Math.abs(newValue - previousValue);
        }

        eventBus.emit({
            type: 'FORECAST_CHANGED',
            payload: {
                cityId,
                provider,
                previousValue,
                newValue,
                changeAmount,
                timestamp: new Date(),
            },
        });

        logger.info(`📊 Forecast changed for ${cityId} from ${provider}`, {
            changeAmount: changeAmount.toFixed(1),
        });
    }

    /**
     * Get secondary providers (all except Tomorrow.io)
     */
    private getSecondaryProviders(cityId: string): IWeatherProvider[] {
        const providers: IWeatherProvider[] = [];
        const providerCount = this.providerManager.getProviderCount();

        for (let i = 0; i < providerCount; i++) {
            const provider = this.providerManager.getProvider(undefined, i, false);
            if (provider && provider.name !== 'tomorrow') {
                providers.push(provider);
            }
        }

        return providers;
    }

    /**
     * Get Tomorrow.io provider if available
     */
    private getTomorrowProvider(): IWeatherProvider | null {
        const providerCount = this.providerManager.getProviderCount();

        for (let i = 0; i < providerCount; i++) {
            const provider = this.providerManager.getProvider(undefined, i, false);
            if (provider && provider.name === 'tomorrow') {
                return provider;
            }
        }

        return null;
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
     * Dispose of the controller and clean up resources
     */
    dispose(): void {
        this.isDisposed = true;

        // Stop all polling
        for (const cityId of this.activePollers.keys()) {
            this.stopPolling(cityId);
        }

        this.activePollers.clear();
        this.lastForecastData.clear();

        logger.info('FetchModeController disposed');
    }
}
