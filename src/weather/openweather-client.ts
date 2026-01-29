/**
 * OpenWeatherMap API Client
 * Provides international weather data (requires API key)
 * Documentation: https://openweathermap.org/api
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Coordinates, WeatherData, HourlyForecast, IWeatherProvider } from './types.js';

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
        snow?: { '3h': number };
        rain?: { '3h': number };
    }>;
    city: {
        name: string;
        coord: { lat: number; lon: number };
        timezone: number;
    };
}

export class OpenWeatherClient implements IWeatherProvider {
    name = 'openweather';
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
    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
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

                // 3h snow accumulation converted to hourly rate approx
                const snow3h = item.snow?.['3h'] || 0; // mm? No, units=imperial means inches?
                // OpenWeatherMap docs: "Precipitation volume for the last 3 hours, mm" even with units=imperial?
                // Docs say: "Units of measurement: ... imperial: ... snow volume: mm".
                // Wait, docs usually say mm for precip regardless of units in some versions, but let's check standard.
                // Standard: "Precipitation volume ... mm".
                // So snow is likely mm. Convert to inches. 1 inch = 25.4 mm.
                const snowInches = (snow3h / 25.4) / 3; // inches per hour

                return {
                    timestamp,
                    temperatureF: Math.round(item.main.temp),
                    temperatureC: this.fahrenheitToCelsius(item.main.temp),
                    feelsLikeF: Math.round(item.main.feels_like),
                    feelsLikeC: this.fahrenheitToCelsius(item.main.feels_like),
                    humidity: item.main.humidity,
                    windSpeedMph: Math.round(item.wind.speed),
                    probabilityOfPrecipitation: Math.round(item.pop * 100),
                    precipitationType: this.detectPrecipType(item.weather[0]?.main, item.snow, item.rain),
                    snowfallInches: parseFloat(snowInches.toFixed(2)),
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
     * Alias for compatibility if needed, though interface uses getHourlyForecast
     */
    async getForecast(coords: Coordinates): Promise<WeatherData> {
        return this.getHourlyForecast(coords);
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