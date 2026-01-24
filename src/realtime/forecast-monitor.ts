/**
 * Forecast Monitor
 * Polls weather APIs and updates DataStore with latest forecasts
 */

import { WeatherService, WeatherData } from '../weather/index.js';
import { DataStore } from './data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private pollIntervalMs: number = 300000; // 5 min default
    private isRunning: boolean = false;
    private pollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();

    constructor(store: DataStore, pollIntervalMs: number = 300000) {
        this.store = store;
        this.weatherService = new WeatherService();
        this.pollIntervalMs = pollIntervalMs;
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

            if (cached && (Date.now() - cached.timestamp.getTime() < 60000)) {
                weatherData = cached.data;
            } else {
                weatherData = await this.weatherService.getForecastByCity(city);
                this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
            }

            for (const market of markets) {
                if (!market.targetDate) continue;

                let probability = 0;
                let forecastValue = 0;

                // Extract forecast value based on metric
                if (market.metricType === 'temperature_high') {
                    const high = await this.weatherService.getExpectedHigh(city, market.targetDate);
                    if (high !== null && market.threshold !== undefined) {
                        forecastValue = high;
                        probability = this.weatherService.calculateTempExceedsProbability(high, market.threshold);
                        if (market.comparisonType === 'below') probability = 1 - probability;
                    }
                } else if (market.metricType === 'snowfall') {
                    // Assume 24h window around target date for simplicity
                    const start = new Date(market.targetDate);
                    start.setHours(0, 0, 0, 0);
                    const end = new Date(market.targetDate);
                    end.setHours(23, 59, 59, 999);

                    const snow = await this.weatherService.getExpectedSnowfall(city, start, end);
                    forecastValue = snow;
                    if (market.threshold !== undefined) {
                        probability = this.weatherService.calculateSnowExceedsProbability(snow, market.threshold);
                    }
                    if (market.comparisonType === 'below') probability = 1 - probability;
                }

                const snapshot: ForecastSnapshot = {
                    marketId: market.market.id,
                    weatherData,
                    forecastValue,
                    probability,
                    timestamp: new Date()
                };

                this.store.updateForecast(market.market.id, snapshot);
            }

        } catch (error) {
            logger.error(`Failed to update forecasts for ${city}`, { error: (error as Error).message });
        }
    }
}
