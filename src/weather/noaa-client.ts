/**
 * NOAA National Weather Service API Client
 * Free, no API key required - provides authoritative US weather data
 * Documentation: https://www.weather.gov/documentation/services-web-api
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Coordinates, WeatherData, HourlyForecast, DailyForecast } from './types.js';

interface NOAAPointResponse {
    properties: {
        gridId: string;
        gridX: number;
        gridY: number;
        forecastHourly: string;
        forecast: string;
        relativeLocation?: {
            properties?: {
                city?: string;
                state?: string;
            };
        };
    };
}

interface NOAAHourlyForecastResponse {
    properties: {
        periods: Array<{
            number: number;
            startTime: string;
            endTime: string;
            isDaytime: boolean;
            temperature: number;
            temperatureUnit: string;
            windSpeed: string;
            windDirection: string;
            shortForecast: string;
            probabilityOfPrecipitation: {
                value: number | null;
            };
            relativeHumidity?: {
                value: number | null;
            };
        }>;
    };
}

interface NOAAForecastResponse {
    properties: {
        periods: Array<{
            number: number;
            name: string;
            startTime: string;
            endTime: string;
            isDaytime: boolean;
            temperature: number;
            temperatureUnit: string;
            shortForecast: string;
            detailedForecast: string;
            probabilityOfPrecipitation: {
                value: number | null;
            };
        }>;
    };
}

export class NOAAClient {
    private client: AxiosInstance;
    private pointCache: Map<string, { gridId: string; gridX: number; gridY: number; locationName: string }> = new Map();

    constructor() {
        this.client = axios.create({
            baseURL: config.noaaHost,
            headers: {
                'User-Agent': 'PolymarketWeatherBot/1.0 (contact@example.com)',
                'Accept': 'application/geo+json',
            },
            timeout: 15000,
        });
    }

    /**
     * Get grid point data for coordinates (required before fetching forecasts)
     */
    private async getGridPoint(coords: Coordinates): Promise<{ gridId: string; gridX: number; gridY: number; locationName: string }> {
        const cacheKey = `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;

        if (this.pointCache.has(cacheKey)) {
            return this.pointCache.get(cacheKey)!;
        }

        try {
            const response = await this.client.get<NOAAPointResponse>(`/points/${coords.lat},${coords.lon}`);
            const { gridId, gridX, gridY, relativeLocation } = response.data.properties;

            const city = relativeLocation?.properties?.city || '';
            const state = relativeLocation?.properties?.state || '';
            const locationName = city && state ? `${city}, ${state}` : `${coords.lat}, ${coords.lon}`;

            const result = { gridId, gridX, gridY, locationName };
            this.pointCache.set(cacheKey, result);

            logger.debug(`NOAA grid point resolved: ${locationName} -> ${gridId}/${gridX},${gridY}`);
            return result;
        } catch (error: any) {
            if (error.response && error.response.status === 404) {
                logger.warn(`Location not covered by NOAA (404): ${coords.lat}, ${coords.lon}`);
            } else {
                logger.error('Failed to get NOAA grid point', { coords, error: (error as Error).message });
            }
            throw error;
        }
    }

    /**
     * Fetch hourly forecast for a location (up to 156 hours / 6.5 days)
     */
    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        const gridPoint = await this.getGridPoint(coords);

        try {
            const url = `/gridpoints/${gridPoint.gridId}/${gridPoint.gridX},${gridPoint.gridY}/forecast/hourly`;
            const response = await this.client.get<NOAAHourlyForecastResponse>(url);

            const hourly: HourlyForecast[] = response.data.properties.periods.map(period => {
                const tempF = period.temperatureUnit === 'F' ? period.temperature : this.celsiusToFahrenheit(period.temperature);
                const tempC = period.temperatureUnit === 'C' ? period.temperature : this.fahrenheitToCelsius(period.temperature);

                const probPrecip = period.probabilityOfPrecipitation?.value ?? 0;
                const precipType = this.detectPrecipType(period.shortForecast);
                
                // Snowfall disabled/removed
                const snowfallInches = 0;

                return {
                    timestamp: new Date(period.startTime),
                    temperatureF: tempF,
                    temperatureC: tempC,
                    humidity: period.relativeHumidity?.value ?? undefined,
                    windSpeedMph: this.parseWindSpeed(period.windSpeed),
                    windDirection: period.windDirection,
                    probabilityOfPrecipitation: probPrecip,
                    precipitationType: precipType,
                    snowfallInches: snowfallInches,
                    shortForecast: period.shortForecast,
                    isDaytime: period.isDaytime,
                };
            });

            return {
                location: coords,
                locationName: gridPoint.locationName,
                fetchedAt: new Date(),
                source: 'noaa',
                hourly,
            };
        } catch (error) {
            logger.error('Failed to fetch NOAA hourly forecast', { coords, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Fetch daily forecast (12-hour periods)
     */
    async getDailyForecast(coords: Coordinates): Promise<DailyForecast[]> {
        const gridPoint = await this.getGridPoint(coords);

        try {
            const url = `/gridpoints/${gridPoint.gridId}/${gridPoint.gridX},${gridPoint.gridY}/forecast`;
            const response = await this.client.get<NOAAForecastResponse>(url);

            // Group periods by day and extract high/low
            const dailyMap = new Map<string, { highs: number[]; lows: number[]; pop: number[]; forecast: string }>();

            for (const period of response.data.properties.periods) {
                const date = new Date(period.startTime).toISOString().split('T')[0];

                if (!dailyMap.has(date)) {
                    dailyMap.set(date, { highs: [], lows: [], pop: [], forecast: '' });
                }

                const dayData = dailyMap.get(date)!;
                const tempF = period.temperatureUnit === 'F' ? period.temperature : this.celsiusToFahrenheit(period.temperature);

                if (period.isDaytime) {
                    dayData.highs.push(tempF);
                    dayData.forecast = period.shortForecast;
                } else {
                    dayData.lows.push(tempF);
                }

                if (period.probabilityOfPrecipitation?.value) {
                    dayData.pop.push(period.probabilityOfPrecipitation.value);
                }
            }

            const daily: DailyForecast[] = [];
            for (const [dateStr, data] of dailyMap) {
                const highF = data.highs.length > 0 ? Math.max(...data.highs) : 0;
                const lowF = data.lows.length > 0 ? Math.min(...data.lows) : 0;

                daily.push({
                    date: new Date(dateStr),
                    highF,
                    lowF,
                    highC: this.fahrenheitToCelsius(highF),
                    lowC: this.fahrenheitToCelsius(lowF),
                    probabilityOfPrecipitation: data.pop.length > 0 ? Math.max(...data.pop) : 0,
                    shortForecast: data.forecast,
                });
            }

            return daily;
        } catch (error) {
            logger.error('Failed to fetch NOAA daily forecast', { coords, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get the expected high temperature for a specific date
     */
    async getExpectedHigh(coords: Coordinates, date: Date): Promise<number | null> {
        const weather = await this.getHourlyForecast(coords);
        const targetDate = date.toISOString().split('T')[0];

        const dayTemps = weather.hourly
            .filter(h => h.timestamp.toISOString().split('T')[0] === targetDate && h.isDaytime)
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    /**
     * Get expected snowfall for a date range (inches)
     * Uses intensity-based estimation from forecast text and conditions
     */
    async getExpectedSnowfall(coords: Coordinates, startDate: Date, endDate: Date): Promise<number> {
        const weather = await this.getHourlyForecast(coords);

        let totalSnowfall = 0;

        for (const hour of weather.hourly) {
            if (hour.timestamp >= startDate && hour.timestamp <= endDate) {
                if (hour.precipitationType === 'snow' && hour.probabilityOfPrecipitation > 30) {
                    // Estimate snowfall rate based on forecast intensity keywords and conditions
                    const snowRate = this.estimateSnowRate(hour.shortForecast || '', hour.temperatureF, hour.probabilityOfPrecipitation);

                    // Weight by probability (e.g., 60% chance = 0.6 multiplier)
                    const probabilityWeight = hour.probabilityOfPrecipitation / 100;
                    totalSnowfall += snowRate * probabilityWeight;
                }
            }
        }

        return Math.round(totalSnowfall * 10) / 10; // Round to 1 decimal
    }

    /**
     * Estimate hourly snow rate (inches/hour) based on forecast text and conditions
     */
    private estimateSnowRate(forecast: string, tempF: number, probability: number): number {
        const lower = forecast.toLowerCase();

        // Base rate depends on intensity keywords
        let baseRate: number;

        if (lower.includes('heavy snow') || lower.includes('blizzard') || lower.includes('significant snow')) {
            baseRate = 1.5; // Heavy: 1-2+ inches/hour
        } else if (lower.includes('moderate snow')) {
            baseRate = 0.75; // Moderate: 0.5-1 inch/hour
        } else if (lower.includes('light snow') || lower.includes('snow flurries') || lower.includes('flurries')) {
            baseRate = 0.2; // Light: 0.1-0.3 inches/hour
        } else if (lower.includes('snow showers')) {
            baseRate = 0.4; // Showers: intermittent, variable
        } else if (lower.includes('snow')) {
            // Generic "snow" - use moderate-light estimate
            baseRate = 0.5;
        } else {
            baseRate = 0.3; // Default conservative estimate
        }

        // Adjust based on temperature (colder = fluffier snow = more accumulation)
        // Snow-to-liquid ratio: ~10:1 at 30°F, ~15:1 at 20°F, ~20:1 at 10°F
        let tempMultiplier = 1.0;
        if (tempF < 15) {
            tempMultiplier = 1.5; // Very cold = fluffy snow, higher accumulation
        } else if (tempF < 25) {
            tempMultiplier = 1.2; // Cold = good accumulation
        } else if (tempF > 30) {
            tempMultiplier = 0.7; // Near freezing = wet snow, less accumulation
        }

        return baseRate * tempMultiplier;
    }


    private fahrenheitToCelsius(f: number): number {
        return Math.round(((f - 32) * 5 / 9) * 10) / 10;
    }

    private celsiusToFahrenheit(c: number): number {
        return Math.round((c * 9 / 5 + 32) * 10) / 10;
    }

    private parseWindSpeed(windStr: string): number {
        // Parse "10 mph" or "10 to 15 mph"
        const match = windStr.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    private detectPrecipType(forecast: string): 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' {
        const lower = forecast.toLowerCase();
        if (lower.includes('snow')) return 'snow';
        if (lower.includes('sleet') || lower.includes('ice')) return 'sleet';
        if (lower.includes('rain') || lower.includes('shower')) return 'rain';
        if (lower.includes('mix')) return 'mixed';
        return 'none';
    }
}
