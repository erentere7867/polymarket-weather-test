/**
 * Open-Meteo Weather Client
 * Free, open-source weather API with no API key required
 * https://open-meteo.com/
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../logger.js';
import { Coordinates, WeatherData, HourlyForecast } from './types.js';

interface OpenMeteoResponse {
    latitude: number;
    longitude: number;
    timezone: string;
    hourly: {
        time: string[];
        temperature_2m: number[];
        relative_humidity_2m: number[];
        precipitation_probability: number[];
        precipitation: number[];
        snowfall: number[];
        weather_code: number[];
        wind_speed_10m: number[];
        wind_direction_10m: number[];
    };
    daily?: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: number[];
        snowfall_sum: number[];
    };
}

// Weather codes from Open-Meteo
const WEATHER_CODE_MAP: { [key: number]: string } = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
};

export class OpenMeteoClient {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: 'https://api.open-meteo.com/v1',
            timeout: 15000,
        });
    }

    /**
     * Get hourly forecast for coordinates
     */
    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        try {
            const response = await this.client.get<OpenMeteoResponse>('/forecast', {
                params: {
                    latitude: coords.lat,
                    longitude: coords.lon,
                    hourly: [
                        'temperature_2m',
                        'relative_humidity_2m',
                        'precipitation_probability',
                        'precipitation',
                        'snowfall',
                        'weather_code',
                        'wind_speed_10m',
                        'wind_direction_10m',
                    ].join(','),
                    temperature_unit: 'fahrenheit',
                    wind_speed_unit: 'mph',
                    forecast_days: 7,
                },
            });

            const data = response.data;
            const hourly: HourlyForecast[] = [];

            for (let i = 0; i < data.hourly.time.length; i++) {
                const timestamp = new Date(data.hourly.time[i]);
                const hour = timestamp.getHours();

                hourly.push({
                    timestamp,
                    temperatureF: Math.round(data.hourly.temperature_2m[i]),
                    temperatureC: this.fahrenheitToCelsius(data.hourly.temperature_2m[i]),
                    humidity: data.hourly.relative_humidity_2m[i],
                    windSpeedMph: Math.round(data.hourly.wind_speed_10m[i]),
                    probabilityOfPrecipitation: data.hourly.precipitation_probability[i],
                    precipitationType: this.getPrecipType(
                        data.hourly.weather_code[i],
                        data.hourly.snowfall[i]
                    ),
                    snowfallInches: (data.hourly.snowfall[i] || 0) / 2.54, // cm to inches
                    shortForecast: WEATHER_CODE_MAP[data.hourly.weather_code[i]] || 'Unknown',
                    isDaytime: hour >= 6 && hour < 18,
                });
            }

            return {
                location: coords,
                locationName: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
                fetchedAt: new Date(),
                source: 'openmeteo',
                hourly,
            };
        } catch (error) {
            logger.error('Failed to fetch Open-Meteo forecast', { coords, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get expected high temperature for a date
     */
    async getExpectedHigh(coords: Coordinates, date: Date): Promise<number | null> {
        const weather = await this.getHourlyForecast(coords);
        const targetDate = date.toISOString().split('T')[0];

        const dayTemps = weather.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate)
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    /**
     * Get expected snowfall for a date range
     */
    async getExpectedSnowfall(coords: Coordinates, startDate: Date, endDate: Date): Promise<number> {
        try {
            const response = await this.client.get<OpenMeteoResponse>('/forecast', {
                params: {
                    latitude: coords.lat,
                    longitude: coords.lon,
                    hourly: 'snowfall',
                    forecast_days: 7,
                },
            });

            let totalSnow = 0;
            const data = response.data;

            for (let i = 0; i < data.hourly.time.length; i++) {
                const timestamp = new Date(data.hourly.time[i]);
                if (timestamp >= startDate && timestamp <= endDate) {
                    // Snowfall is in cm, convert to inches
                    totalSnow += (data.hourly.snowfall[i] || 0) / 2.54;
                }
            }

            return Math.round(totalSnow * 10) / 10;
        } catch (error) {
            logger.error('Failed to fetch Open-Meteo snowfall', { error: (error as Error).message });
            return 0;
        }
    }

    private fahrenheitToCelsius(f: number): number {
        return Math.round(((f - 32) * 5 / 9) * 10) / 10;
    }

    private getPrecipType(
        weatherCode: number,
        snowfall: number
    ): 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' {
        if (snowfall > 0) return 'snow';
        if (weatherCode >= 71 && weatherCode <= 77) return 'snow';
        if (weatherCode >= 85 && weatherCode <= 86) return 'snow';
        if (weatherCode >= 51 && weatherCode <= 65) return 'rain';
        if (weatherCode >= 80 && weatherCode <= 82) return 'rain';
        if (weatherCode >= 95) return 'rain';
        return 'none';
    }
}
