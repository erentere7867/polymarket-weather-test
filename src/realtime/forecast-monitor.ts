/**
 * Forecast Monitor
 * Polls weather APIs and updates DataStore with latest forecasts
 */

import { WeatherService, WeatherData } from '../weather/index.js';
import { DataStore } from './data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { MultiSourceMonitor } from './multi-source-monitor.js';
import { RateLimiter } from './rate-limiter.js';
import { TomorrowClient } from '../weather/clients/tomorrow-client.js';
import { WeatherApiClient } from '../weather/clients/weatherapi-client.js';
import { WeatherbitClient } from '../weather/clients/weatherbit-client.js';
import { VisualCrossingClient } from '../weather/clients/visualcrossing-client.js';
import { MeteosourceClient } from '../weather/clients/meteosource-client.js';
import { findCity } from '../weather/types.js';

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private pollIntervalMs: number;
    private isRunning: boolean = false;
    private pollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();

    private multiSourceMonitor: MultiSourceMonitor;
    private multiSourceInterval: NodeJS.Timeout | null = null;
    private rateLimiter: RateLimiter;

    constructor(store: DataStore, pollIntervalMs?: number) {
        this.store = store;
        this.weatherService = new WeatherService();
        // Use config default (30s) for speed arbitrage, or allow override
        this.pollIntervalMs = pollIntervalMs ?? config.forecastPollIntervalMs;

        // Initialize Multi-Source Monitor
        this.rateLimiter = new RateLimiter();
        this.multiSourceMonitor = new MultiSourceMonitor(this.rateLimiter);
        this.initializeClients();
        this.setupMultiSourceEvents();

        logger.info(`ForecastMonitor initialized with ${this.pollIntervalMs / 1000}s polling interval`);
    }

    private initializeClients(): void {
        const clients = [
            new TomorrowClient({ name: 'Tomorrow.io', rateLimit: 500, enabled: true, apiKey: config.tomorrowApiKey }),
            new WeatherApiClient({ name: 'WeatherAPI', rateLimit: 30000, enabled: true, apiKey: config.weatherApiKey }),
            new WeatherbitClient({ name: 'Weatherbit', rateLimit: 500, enabled: true, apiKey: config.weatherbitApiKey }),
            new VisualCrossingClient({ name: 'Visual Crossing', rateLimit: 1000, enabled: true, apiKey: config.visualCrossingApiKey }),
            new MeteosourceClient({ name: 'Meteosource', rateLimit: 400, enabled: true, apiKey: config.meteosourceApiKey })
        ];

        for (const client of clients) {
            this.multiSourceMonitor.addSource(client);
        }
    }

    private setupMultiSourceEvents(): void {
        this.multiSourceMonitor.on('forecast-changed', async (event) => {
            // event: { city, source, oldValue, newValue, timestamp, fullResult }
            logger.info(`⚡ Fast Update (${event.source}) for ${event.city}: ${event.newValue}°F`);

            // Construct pseudo WeatherData from result
            // Since these APIs usually return simple temp, we fill gaps or fetch full if needed.
            // But for speed, we use the temperature directly to update the cache and trigger logic.

            // Fetch markets for this city
            const markets = this.store.getAllMarkets().filter(m => m.city === event.city);
            if (markets.length === 0) return;

            // Update cache with this new data point
            const coords = findCity(event.city)?.coordinates || { lat: 0, lon: 0 };

            // Create minimal WeatherData for cache-hit
            const newData: WeatherData = {
                location: coords,
                fetchedAt: new Date(),
                source: 'openweather', // flagging as external/fast
                hourly: [{
                    timestamp: new Date(),
                    temperatureF: event.newValue,
                    temperatureC: (event.newValue - 32) * 5 / 9,
                    isDaytime: true,
                    probabilityOfPrecipitation: 0
                }]
            };
            this.cityCache.set(event.city, { data: newData, timestamp: new Date() });

            // Trigger analysis immediately
            await this.updateCityForecasts(event.city, markets);
        });
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.poll();
        this.startMultiSourcePolling();
        logger.info('ForecastMonitor started');
    }

    private startMultiSourcePolling(): void {
        if (this.multiSourceInterval) clearInterval(this.multiSourceInterval);

        logger.info(`Starting Multi-Source Racing Monitor (${config.multiSourcePollIntervalMs}ms interval)`);
        this.multiSourceInterval = setInterval(() => {
            const cityResolver = async (city: string) => {
                const loc = findCity(city);
                return loc ? loc.coordinates : null;
            };
            this.multiSourceMonitor.pollNext(cityResolver);
        }, config.multiSourcePollIntervalMs);
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        this.isRunning = false;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        if (this.multiSourceInterval) {
            clearInterval(this.multiSourceInterval);
            this.multiSourceInterval = null;
        }
        logger.info('ForecastMonitor stopped');
    }

    private async poll(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const markets = this.store.getAllMarkets();
            // Group by city to avoid duplicate fetches
            const cityGroups = new Map<string, ParsedWeatherMarket[]>();

            for (const market of markets) {
                if (market.city) {
                    const list = cityGroups.get(market.city) || [];
                    list.push(market);
                    cityGroups.set(market.city, list);
                }
            }

            // Split into US (standard poll) and International (multi-source handled)
            const usCities = new Map<string, ParsedWeatherMarket[]>();
            const internationalCities = new Set<string>();

            for (const [city, cityMarkets] of cityGroups) {
                const location = findCity(city);
                if (location && location.timezone.startsWith('America/')) { // Simple heuristic for US/Canada
                    // Actually, Toronto is America/Toronto but likely want standard flow if NOAA covers it?
                    // NOAA usually only US. 
                    // Let's explicitly check coordinates or known US list.
                    // For implementation simplicity: if 'New York', 'Chicago', etc. -> US.
                    // If 'London', 'Seoul' -> International.

                    // Simple check: Positive longitude is East (Intl usually), Negative is West (Americas).
                    // US is roughly -60 to -125.
                    // Or rely on isUS(coords) helper if available.

                    // For now, treat US as standard polling.
                    // International cities get added to multi-source monitor.
                    // BUT: We don't want to poll them here if multi-source handles them.

                    if (this.weatherService.isInUS(location.coordinates)) {
                        await this.updateCityForecasts(city, cityMarkets);
                    } else {
                        internationalCities.add(city);
                        // Initial fetch or periodic sync for international?
                        // MultiSource handles rapid updates. 
                        // We might want one "Open-Meteo" fetch here as backup/baseline every 30s.
                        // Let's do it to ensure baseline data.
                        await this.updateCityForecasts(city, cityMarkets);
                    }
                } else {
                    // Assume international
                    internationalCities.add(city);
                    // Still standard poll for baseline
                    await this.updateCityForecasts(city, cityMarkets);
                }
            }

            // Update MultiSourceMonitor with current active international cities
            this.multiSourceMonitor.setCities(Array.from(internationalCities));


        } catch (error) {
            logger.error('Forecast poll failed', { error: (error as Error).message });
        }

        // Schedule next poll
        if (this.isRunning) {
            this.pollTimeout = setTimeout(() => this.poll(), this.pollIntervalMs);
        }
    }

    private async updateCityForecasts(city: string, markets: ParsedWeatherMarket[]): Promise<void> {
        try {
            // Check cache (1 min validity)
            let weatherData: WeatherData;
            const cached = this.cityCache.get(city);

            // 15s cache to match MAX_CHANGE_AGE_MS in speed-arbitrage.ts
            if (cached && (Date.now() - cached.timestamp.getTime() < 15000)) {
                weatherData = cached.data;
            } else {
                weatherData = await this.weatherService.getForecastByCity(city);
                this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
            }

            for (const market of markets) {
                if (!market.targetDate) continue;

                let probability = 0;
                let forecastValue: number | null = null;

                // Extract forecast value based on metric
                if (market.metricType === 'temperature_high') {
                    // Use calculated logic to utilize cached/fast-update data
                    let high = this.weatherService.calculateExpectedHigh(weatherData, market.targetDate);
                    if (high !== null && market.threshold !== undefined) {
                        // CRITICAL: Convert forecast to match market threshold units
                        // Forecasts are always in Fahrenheit, but thresholds may be in Celsius
                        if (market.thresholdUnit === 'C') {
                            // Convert Fahrenheit forecast to Celsius for comparison
                            high = (high - 32) * 5 / 9;
                        }
                        forecastValue = high;
                        probability = this.weatherService.calculateTempExceedsProbability(high, market.threshold);
                        if (market.comparisonType === 'below') probability = 1 - probability;
                    }
                } else if (market.metricType === 'snowfall') {
                    // Skip snowfall updates if we are using a "Fast Update" (len=1) which lacks snow data
                    // This prevents zeroing out snowfall forecasts when a temp-only update arrives
                    if (weatherData.hourly.length > 1) {
                        // Assume 24h window around target date for simplicity
                        const start = new Date(market.targetDate);
                        start.setHours(0, 0, 0, 0);
                        const end = new Date(market.targetDate);
                        end.setHours(23, 59, 59, 999);

                        // Keep using getExpectedSnowfall for now (until HourlyForecast supports snow)
                        // But strictly only when we have full data.
                        // Note: This still incurs a network call if getExpectedSnowfall doesn't use cache.
                        // Ideally we should refactor getExpectedSnowfall to use 'weatherData' too,
                        // but since 'weatherData' (OpenMeteo) lacks snow, we might need to fetch anyway.
                        const snow = await this.weatherService.getExpectedSnowfall(city, start, end);
                        forecastValue = snow;
                        if (market.threshold !== undefined) {
                            probability = this.weatherService.calculateSnowExceedsProbability(snow, market.threshold);
                        }
                        if (market.comparisonType === 'below') probability = 1 - probability;
                    }
                }

                if (forecastValue === null) continue;

                // SPEED ARBITRAGE: Detect if forecast value actually changed
                const currentState = this.store.getMarketState(market.market.id);
                const previousValue = currentState?.lastForecast?.forecastValue;
                const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

                // Calculate change amount
                const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

                // Determine significant change threshold based on metric type
                let significantChangeThreshold: number;
                switch (market.metricType) {
                    case 'temperature_high':
                    case 'temperature_low':
                    case 'temperature_threshold':
                        significantChangeThreshold = 1; // 1°F change is significant
                        break;
                    case 'snowfall':
                        significantChangeThreshold = 0.5; // 0.5 inch change is significant
                        break;
                    default:
                        significantChangeThreshold = 1;
                }

                // Did the value change significantly?
                const valueChanged = changeAmount >= significantChangeThreshold;
                const now = new Date();

                // Track when the change occurred
                // If changed now, use current time. Otherwise, keep previous change time
                // FIX: If no previous timestamp (startup), assume data is old (Date(0)) to prevent
                // firing speed arbitrage on initial load.
                const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || new Date(0));

                if (valueChanged) {
                    logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`, {
                        previousValue: previousValue?.toFixed(1),
                        newValue: forecastValue.toFixed(1),
                        changeAmount: changeAmount.toFixed(1),
                        threshold: market.threshold,
                    });
                }

                const snapshot: ForecastSnapshot = {
                    marketId: market.market.id,
                    weatherData,
                    forecastValue,
                    probability,
                    timestamp: now,
                    // Speed arbitrage fields
                    previousValue,
                    valueChanged,
                    changeAmount,
                    changeTimestamp,
                };

                this.store.updateForecast(market.market.id, snapshot);
            }

        } catch (error) {
            logger.error(`Failed to update forecasts for ${city}`, { error: (error as Error).message });
        }
    }
}

