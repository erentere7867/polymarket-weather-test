/**
 * Weather Service - aggregates weather data from multiple sources
 */

import { NOAAClient } from './noaa-client.js';
import { OpenWeatherClient } from './openweather-client.js';
import { OpenMeteoClient } from './openmeteo-client.js';
import { Coordinates, WeatherData, findCity, KNOWN_CITIES } from './types.js';
import { logger } from '../logger.js';

export class WeatherService {
    private noaaClient: NOAAClient;
    private openWeatherClient: OpenWeatherClient;
    private openMeteoClient: OpenMeteoClient;

    // US bounding box (rough)
    private readonly US_BOUNDS = {
        minLat: 24.5,
        maxLat: 49.0,
        minLon: -125.0,
        maxLon: -66.5,
    };

    constructor() {
        this.noaaClient = new NOAAClient();
        this.openWeatherClient = new OpenWeatherClient();
        this.openMeteoClient = new OpenMeteoClient();
    }

    /**
     * Check if coordinates are within the continental US
     */
    private isInUS(coords: Coordinates): boolean {
        return (
            coords.lat >= this.US_BOUNDS.minLat &&
            coords.lat <= this.US_BOUNDS.maxLat &&
            coords.lon >= this.US_BOUNDS.minLon &&
            coords.lon <= this.US_BOUNDS.maxLon
        );
    }

    /**
     * Get weather forecast for a location, selecting the best available source
     * Priority: NOAA (US) -> OpenWeatherMap -> Open-Meteo (free fallback)
     */
    async getForecast(coords: Coordinates): Promise<WeatherData> {
        // Prefer NOAA for US locations (free and authoritative)
        if (this.isInUS(coords)) {
            try {
                return await this.noaaClient.getHourlyForecast(coords);
            } catch (error) {
                logger.warn('NOAA fetch failed, trying fallbacks', { error: (error as Error).message });
            }
        }

        // Try OpenWeatherMap if configured
        if (this.openWeatherClient.isConfigured()) {
            try {
                return await this.openWeatherClient.getForecast(coords);
            } catch (error) {
                logger.warn('OpenWeatherMap fetch failed, trying Open-Meteo', { error: (error as Error).message });
            }
        }

        // Fall back to Open-Meteo (free, no API key required)
        try {
            return await this.openMeteoClient.getHourlyForecast(coords);
        } catch (error) {
            logger.error('All weather sources failed', { error: (error as Error).message });
            throw new Error(`No weather data source available for location: ${coords.lat}, ${coords.lon}`);
        }
    }

    /**
     * Get forecast by city name
     */
    async getForecastByCity(cityName: string): Promise<WeatherData> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }
        return this.getForecast(city.coordinates);
    }

    /**
     * Get expected high temperature for a city on a specific date
     */
    async getExpectedHigh(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        if (this.isInUS(city.coordinates)) {
            return this.noaaClient.getExpectedHigh(city.coordinates, date);
        }

        if (this.openWeatherClient.isConfigured()) {
            return this.openWeatherClient.getExpectedHigh(city.coordinates, date);
        }

        return null;
    }

    /**
     * Get expected low temperature for a city on a specific date
     */
    async getExpectedLow(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const forecast = await this.getForecast(city.coordinates);
        const targetDate = date.toISOString().split('T')[0];

        const temps = forecast.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate)
            .map(h => h.temperatureF);

        if (temps.length === 0) return null;
        return Math.min(...temps);
    }

    /**
     * Get expected snowfall for a location over a date range
     */
    async getExpectedSnowfall(cityName: string, startDate: Date, endDate: Date): Promise<number> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        if (this.isInUS(city.coordinates)) {
            return this.noaaClient.getExpectedSnowfall(city.coordinates, startDate, endDate);
        }

        if (this.openWeatherClient.isConfigured()) {
            return this.openWeatherClient.getExpectedSnowfall(city.coordinates, startDate, endDate);
        }

        return 0;
    }

    /**
     * Calculate probability that temperature will exceed a threshold
     * Returns 0-1 probability based on forecast vs threshold
     */
    calculateTempExceedsProbability(forecastTemp: number, threshold: number, uncertainty: number = 3): number {
        // Model forecast uncertainty as a normal distribution
        // Probability = area under curve above threshold
        // Using a simple sigmoid approximation for speed

        const diff = forecastTemp - threshold;
        const z = diff / uncertainty; // Normalize by uncertainty

        // Sigmoid approximation to cumulative normal
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
