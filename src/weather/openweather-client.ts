/**
 * OpenWeatherMap API Client
 * Provides international weather data (requires API key)
 * Documentation: https://openweathermap.org/api
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Coordinates, WeatherData, HourlyForecast, DailyForecast } from './types.js';

interface OWMCurrentResponse {
    coord: { lon: number; lat: number };
    weather: Array<{ id: number; main: string; description: string }>;
    main: {
        temp: number;
        feels_like: number;
        temp_min: number;
        temp_max: number;
        humidity: number;
    };
    wind: { speed: number; deg: number };
    name: string;
    dt: number;
}

interface OWMForecastResponse {
    list: Array<{
        dt: number;
        main: {
            temp: number;
            feels_like: number;
            temp_min: number;
            temp_max: number;
            humidity: number;
        };
        weather: Array<{ id: number; main: string; description: string }>;
        wind: { speed: number; deg: number };
        pop: number; // Probability of precipitation (0-1)
        snow?: { '3h'?: number; '1h'?: number };
        rain?: { '3h'?: number; '1h'?: number };
    }>;
    city: {
        name: string;
        coord: { lat: number; lon: number };
        timezone: number;
    };
}

interface OWMOneCallResponse {
    lat: number;
    lon: number;
    timezone: string;
    current: {
        dt: number;
        temp: number;
        feels_like: number;
        humidity: number;
        wind_speed: number;
        weather: Array<{ id: number; main: string; description: string }>;
    };
    hourly: Array<{
        dt: number;
        temp: number;
        feels_like: number;
        humidity: number;
        wind_speed: number;
        weather: Array<{ id: number; main: string; description: string }>;
        pop: number;
        snow?: { '1h': number };
        rain?: { '1h': number };
    }>;
    daily: Array<{
        dt: number;
        temp: { day: number; min: number; max: number; night: number };
        feels_like: { day: number; night: number };
        humidity: number;
        wind_speed: number;
        weather: Array<{ id: number; main: string; description: string }>;
        pop: number;
        snow?: number;
        rain?: number;
    }>;
}

export class OpenWeatherClient {
    private client: AxiosInstance;
    private apiKey: string;

    constructor() {
        this.apiKey = config.openWeatherApiKey;
        this.client = axios.create({
            baseURL: 'https://api.openweathermap.org/data/2.5',
            timeout: 15000,
        });
    }

    /**
     * Check if the client is configured with an API key
     */
    isConfigured(): boolean {
        return this.apiKey.length > 0;
    }

    /**
     * Fetch 5-day/3-hour forecast (free tier)
     */
    async getForecast(coords: Coordinates): Promise<WeatherData> {
        if (!this.isConfigured()) {
            throw new Error('OpenWeatherMap API key not configured');
        }

        try {
            const response = await this.client.get<OWMForecastResponse>('/forecast', {
                params: {
                    lat: coords.lat,
                    lon: coords.lon,
                    appid: this.apiKey,
                    units: 'imperial', // Get temperatures in Fahrenheit
                },
            });

            const hourly: HourlyForecast[] = response.data.list.map(item => {
                const timestamp = new Date(item.dt * 1000);
                const hour = timestamp.getHours();

                const precipType = this.detectPrecipType(item.weather[0]?.main, item.snow, item.rain);
                const pop = Math.round(item.pop * 100);

                let snowfallInches = 0;
                if (item.snow && (item.snow['3h'] || item.snow['1h'])) {
                    const mm = (item.snow['3h'] || 0) + (item.snow['1h'] || 0);
                    snowfallInches = mm / 25.4;
                } else if (precipType === 'snow' && pop > 50) {
                    snowfallInches = 0.5; // Rough estimate per 3-hour period
                }

                return {
                    timestamp,
                    temperatureF: Math.round(item.main.temp),
                    temperatureC: this.fahrenheitToCelsius(item.main.temp),
                    feelsLikeF: Math.round(item.main.feels_like),
                    feelsLikeC: this.fahrenheitToCelsius(item.main.feels_like),
                    humidity: item.main.humidity,
                    windSpeedMph: Math.round(item.wind.speed),
                    probabilityOfPrecipitation: pop,
                    precipitationType: precipType,
                    snowfallInches,
                    shortForecast: item.weather[0]?.description || '',
                    isDaytime: hour >= 6 && hour < 18,
                };
            });

            return {
                location: coords,
                locationName: response.data.city.name,
                fetchedAt: new Date(),
                source: 'openweather',
                hourly,
            };
        } catch (error) {
            logger.error('Failed to fetch OpenWeatherMap forecast', { coords, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get expected high temperature for a specific date
     */
    async getExpectedHigh(coords: Coordinates, date: Date): Promise<number | null> {
        const weather = await this.getForecast(coords);
        const targetDate = date.toISOString().split('T')[0];

        const dayTemps = weather.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate && h.isDaytime)
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    /**
     * Get expected low temperature for a specific date
     */
    async getExpectedLow(coords: Coordinates, date: Date): Promise<number | null> {
        const weather = await this.getForecast(coords);
        const targetDate = date.toISOString().split('T')[0];

        const nightTemps = weather.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate && !h.isDaytime)
            .map(h => h.temperatureF);

        if (nightTemps.length === 0) return null;
        return Math.min(...nightTemps);
    }

    /**
     * Get expected snowfall for a date range (inches)
     */
    async getExpectedSnowfall(coords: Coordinates, startDate: Date, endDate: Date): Promise<number> {
        const weather = await this.getForecast(coords);

        let totalSnow = 0;
        for (const hour of weather.hourly) {
            if (hour.timestamp >= startDate && hour.timestamp <= endDate) {
                if (hour.precipitationType === 'snow' && hour.probabilityOfPrecipitation > 50) {
                    // Estimate based on precip probability and temp
                    totalSnow += 0.5; // Rough estimate per 3-hour period
                }
            }
        }

        return totalSnow;
    }

    private fahrenheitToCelsius(f: number): number {
        return Math.round(((f - 32) * 5 / 9) * 10) / 10;
    }

    private detectPrecipType(
        weatherMain: string | undefined,
        snow: { '3h'?: number; '1h'?: number } | undefined,
        rain: { '3h'?: number; '1h'?: number } | undefined
    ): 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' {
        if (snow && (snow['3h'] || snow['1h'])) return 'snow';
        if (rain && (rain['3h'] || rain['1h'])) return 'rain';

        const main = (weatherMain || '').toLowerCase();
        if (main === 'snow') return 'snow';
        if (main === 'rain' || main === 'drizzle') return 'rain';
        if (main === 'sleet') return 'sleet';

        return 'none';
    }
}
