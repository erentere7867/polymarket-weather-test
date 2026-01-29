/**
 * Weather Service - aggregates weather data from multiple sources
 * Implements robust round-robin provider rotation and standardized data processing.
 */

import { NOAAClient } from './noaa-client.js';
import { WeatherProviderManager } from './provider-manager.js';
import { Coordinates, WeatherData, findCity, KNOWN_CITIES } from './types.js';
import { logger } from '../logger.js';

export class WeatherService {
    private noaaClient: NOAAClient;
    private providerManager: WeatherProviderManager;

    // US bounding box (rough)
    private readonly US_BOUNDS = {
        minLat: 24.5,
        maxLat: 49.0,
        minLon: -125.0,
        maxLon: -66.5,
    };

    constructor() {
        this.noaaClient = new NOAAClient();
        this.providerManager = new WeatherProviderManager();
    }

    /**
     * Check if coordinates are within the continental US
     */
    private isInUS(coords: Coordinates, country?: string): boolean {
        if (country) {
            return country === 'US';
        }
        return (
            coords.lat >= this.US_BOUNDS.minLat &&
            coords.lat <= this.US_BOUNDS.maxLat &&
            coords.lon >= this.US_BOUNDS.minLon &&
            coords.lon <= this.US_BOUNDS.maxLon
        );
    }

    /**
     * Get weather forecast for a location
     * Routes US locations to NOAA, others to the provider manager (round-robin).
     */
    async getForecast(coords: Coordinates, country?: string): Promise<WeatherData> {
        // Prefer NOAA for US locations (free and authoritative)
        if (this.isInUS(coords, country)) {
            try {
                return await this.noaaClient.getHourlyForecast(coords);
            } catch (error) {
                logger.warn('NOAA fetch failed, falling back to global providers', { error: (error as Error).message });
            }
        }

        // Use global provider manager with robust retry
        const attempts = this.providerManager.getProviderCount();
        let lastError: Error | unknown;

        for (let i = 0; i < attempts; i++) {
            try {
                const provider = this.providerManager.getProvider();
                return await provider.getHourlyForecast(coords);
            } catch (error) {
                lastError = error;
                const providerName = this.providerManager.getCurrentProviderName();
                logger.warn(`Provider '${providerName}' failed, skipping immediately.`, { error: (error as Error).message });
                
                // Skip to next provider immediately
                this.providerManager.rotateNow();
            }
        }

        logger.error('All weather providers failed', { error: (lastError as Error)?.message });
        throw lastError;
    }

    /**
     * Get forecast by city name
     */
    async getForecastByCity(cityName: string): Promise<WeatherData> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }
        return this.getForecast(city.coordinates, city.country);
    }

    /**
     * Get expected high temperature for a city on a specific date
     */
    async getExpectedHigh(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getForecast(city.coordinates, city.country);
        return WeatherService.calculateHigh(data, date);
    }

    /**
     * Get expected low temperature for a city on a specific date
     */
    async getExpectedLow(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getForecast(city.coordinates, city.country);
        return WeatherService.calculateLow(data, date);
    }

    /**
     * Get expected snowfall for a location over a date range
     */
    async getExpectedSnowfall(cityName: string, date: Date, endDate: Date): Promise<number> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getForecast(city.coordinates, city.country);
        return WeatherService.calculateSnowfall(data, date, endDate);
    }

    // --- Static Calculation Helpers (Efficient Processing) ---

    static calculateHigh(data: WeatherData, date: Date): number | null {
        const targetDate = date.toISOString().split('T')[0];
        
        const dayTemps = data.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate)
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    static calculateLow(data: WeatherData, date: Date): number | null {
        const targetDate = date.toISOString().split('T')[0];
        
        const dayTemps = data.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate)
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.min(...dayTemps);
    }

    static calculateSnowfall(data: WeatherData, startDate: Date, endDate: Date): number {
        let totalSnowfall = 0;
        for (const hour of data.hourly) {
            if (hour.timestamp >= startDate && hour.timestamp <= endDate) {
                totalSnowfall += hour.snowfallInches || 0;
            }
        }
        return Math.round(totalSnowfall * 10) / 10;
    }

    // --- Probability Helpers ---

    /**
     * Calculate probability that temperature will exceed a threshold
     */
    calculateTempExceedsProbability(forecastTemp: number, threshold: number, uncertainty: number = 3): number {
        const diff = forecastTemp - threshold;
        const z = diff / uncertainty;
        const probability = 1 / (1 + Math.exp(-1.7 * z));
        return Math.max(0, Math.min(1, probability));
    }

    /**
     * Calculate probability that snowfall will exceed a threshold
     */
    calculateSnowExceedsProbability(forecastSnow: number, threshold: number, uncertainty: number = 2): number {
        const diff = forecastSnow - threshold;
        const z = diff / uncertainty;
        const probability = 1 / (1 + Math.exp(-1.7 * z));
        return Math.max(0, Math.min(1, probability));
    }

    /**
     * Get all supported cities
     */
    getSupportedCities(): string[] {
        return KNOWN_CITIES.map(c => c.name);
    }
}

export * from './types.js';