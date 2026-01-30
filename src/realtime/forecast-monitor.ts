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

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private pollIntervalMs: number;
    private isRunning: boolean = false;
    private pollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();
    public cacheTtlMs: number = 15000;
    private initializedMarkets: Set<string> = new Set();

    // Callback for significant changes
    public onForecastChanged: ((marketId: string, changeAmount: number) => void) | null = null;

    constructor(store: DataStore, pollIntervalMs?: number, weatherService?: WeatherService) {
        this.store = store;
        this.weatherService = weatherService || new WeatherService();
        // Use config default (30s) for speed arbitrage, or allow override
        this.pollIntervalMs = pollIntervalMs ?? config.forecastPollIntervalMs;
        logger.info(`ForecastMonitor initialized with ${this.pollIntervalMs / 1000}s polling interval`);
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.poll();
        logger.info('ForecastMonitor started');
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

            for (const [city, cityMarkets] of cityGroups) {
                await this.updateCityForecasts(city, cityMarkets);
            }

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
                } else if (market.metricType === 'precipitation') {
                    // Normalize target date for comparison
                    const targetDateObj = new Date(market.targetDate);
                    targetDateObj.setUTCHours(0, 0, 0, 0);

                    const dayForecasts = weatherData.hourly.filter(h => {
                        const hourDate = new Date(h.timestamp);
                        hourDate.setUTCHours(0, 0, 0, 0);
                        return hourDate.getTime() === targetDateObj.getTime();
                    });

                    if (dayForecasts.length > 0) {
                        const maxPrecipProb = Math.max(...dayForecasts.map(h => h.probabilityOfPrecipitation));
                        forecastValue = maxPrecipProb;
                        probability = maxPrecipProb / 100; // 0-1
                        if (market.comparisonType === 'below') probability = 1 - probability; // "Will it NOT rain?"
                        hasValidForecast = true;
                    }
                }

                if (!hasValidForecast) continue;

                // SPEED ARBITRAGE: Detect if forecast value actually changed
                const currentState = this.store.getMarketState(market.market.id);
                const previousValue = currentState?.lastForecast?.forecastValue;
                const previousSource = currentState?.lastForecast?.weatherData?.source;
                const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

                // Calculate change amount
                const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

                // Determine significant change threshold based on metric type
                let significantChangeThreshold: number;
                switch (market.metricType) {
                    case 'temperature_high':
                    case 'temperature_low':
                    case 'temperature_threshold':
                    case 'temperature_range':
                        significantChangeThreshold = 1; // 1°F change is significant
                        break;
                    default:
                        significantChangeThreshold = 1;
                }

                // Did the value change significantly?
                // Only consider it a change if source is the same to avoid noise from provider rotation
                const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
                const valueChanged = !sourceChanged && changeAmount >= significantChangeThreshold;

                const now = new Date();

                // Track when the change occurred
                // If changed now, use current time. Otherwise, keep previous change time
                const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

                // Initialize market if new
                const isNew = !this.initializedMarkets.has(market.market.id);
                if (isNew) {
                    this.initializedMarkets.add(market.market.id);
                }

                // Prevent initial value from triggering change
                const realChange = valueChanged && !isNew;

                if (realChange) {
                    logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`, {
                        previousValue: previousValue?.toFixed(1),
                        newValue: forecastValue.toFixed(1),
                        changeAmount: changeAmount.toFixed(1),
                        threshold: market.threshold,
                        source: weatherData.source,
                        prevSource: previousSource
                    });

                    if (this.onForecastChanged) {
                        this.onForecastChanged(market.market.id, changeAmount);
                    }
                } else if (valueChanged && isNew) {
                    logger.debug(`Initialized baseline forecast for ${city}: ${forecastValue}`);
                }

                const snapshot: ForecastSnapshot = {
                    marketId: market.market.id,
                    weatherData,
                    forecastValue,
                    probability,
                    timestamp: now,
                    // Speed arbitrage fields
                    previousValue,
                    valueChanged: realChange,
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

