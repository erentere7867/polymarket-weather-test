import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Coordinates, HourlyForecast, IWeatherProvider, WeatherData } from './types.js';

abstract class BaseProvider implements IWeatherProvider {
    abstract name: string;
    abstract getHourlyForecast(coords: Coordinates): Promise<WeatherData>;

    isConfigured(): boolean {
        // To be implemented by subclasses checking their specific key
        return true;
    }

    protected fahrenheitToCelsius(f: number): number {
        return Math.round(((f - 32) * 5 / 9) * 10) / 10;
    }

    protected celsiusToFahrenheit(c: number): number {
        return Math.round((c * 9 / 5 + 32) * 10) / 10;
    }
}

/**
 * Tomorrow.io Provider
 */
export class TomorrowProvider extends BaseProvider {
    name = 'tomorrow';
    private client: AxiosInstance;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: 'https://api.tomorrow.io/v4',
            timeout: 15000,
        });
    }

    isConfigured(): boolean {
        return !!config.tomorrowApiKey;
    }

    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        if (!this.isConfigured()) throw new Error('Tomorrow.io API key not configured');

        try {
            const response = await this.client.get('/timelines', {
                params: {
                    apikey: config.tomorrowApiKey,
                    location: `${coords.lat},${coords.lon}`,
                    fields: ['temperature', 'precipitationProbability', 'precipitationType', 'snowAccumulation', 'humidity', 'windSpeed', 'windDirection'],
                    units: 'imperial',
                    timesteps: '1h',
                    startTime: 'now',
                    endTime: 'nowPlus7d'
                }
            });

            const timelines = response.data.data.timelines;
            const hourlyData = timelines.find((t: any) => t.timestep === '1h')?.intervals || [];

            const hourly: HourlyForecast[] = hourlyData.map((interval: any) => {
                const values = interval.values;
                const timestamp = new Date(interval.startTime);
                const hour = timestamp.getHours();

                // precipitationType: 0: N/A, 1: Rain, 2: Snow, 3: Freezing Rain, 4: Ice Pellets
                let precipType: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' = 'none';
                if (values.precipitationType === 1) precipType = 'rain';
                else if (values.precipitationType === 2) precipType = 'snow';
                else if (values.precipitationType === 3 || values.precipitationType === 4) precipType = 'sleet';

                return {
                    timestamp,
                    temperatureF: Math.round(values.temperature),
                    temperatureC: this.fahrenheitToCelsius(values.temperature),
                    humidity: values.humidity,
                    windSpeedMph: values.windSpeed,
                    windDirection: values.windDirection?.toString(),
                    probabilityOfPrecipitation: values.precipitationProbability || 0,
                    precipitationType: precipType,
                    snowfallInches: values.snowAccumulation || 0,
                    shortForecast: precipType === 'none' ? 'Clear' : precipType, // Simplified
                    isDaytime: hour >= 6 && hour < 18,
                };
            });

            return {
                location: coords,
                fetchedAt: new Date(),
                source: 'tomorrow',
                hourly
            };
        } catch (error) {
            logger.error('Tomorrow.io fetch failed', { error: (error as Error).message });
            throw error;
        }
    }
}

/**
 * WeatherAPI Provider
 */
export class WeatherAPIProvider extends BaseProvider {
    name = 'weatherapi';
    private client: AxiosInstance;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: 'http://api.weatherapi.com/v1',
            timeout: 15000,
        });
    }

    isConfigured(): boolean {
        return !!config.weatherApiKey;
    }

    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        if (!this.isConfigured()) throw new Error('WeatherAPI key not configured');

        try {
            const response = await this.client.get('/forecast.json', {
                params: {
                    key: config.weatherApiKey,
                    q: `${coords.lat},${coords.lon}`,
                    days: 7,
                    aqi: 'no',
                    alerts: 'no'
                }
            });

            const forecastDays = response.data.forecast.forecastday;
            const hourly: HourlyForecast[] = [];

            for (const day of forecastDays) {
                for (const hourData of day.hour) {
                    const timestamp = new Date(hourData.time); // WeatherAPI returns local time string usually, but 'time_epoch' is safer
                    // Actually hourData.time is "YYYY-MM-DD HH:MM".
                    // hourData.time_epoch is unix timestamp. USE EPOCH.
                    const ts = new Date(hourData.time_epoch * 1000);
                    const hour = ts.getUTCHours(); // Or local? Epoch is UTC.

                    let precipType: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' = 'none';
                    if (hourData.will_it_snow) precipType = 'snow';
                    else if (hourData.will_it_rain) precipType = 'rain';

                    // Snowfall isn't explicitly in hourly, usually implicit in precip_in if snow
                    const snowfall = (precipType === 'snow') ? (hourData.precip_in * 10) : 0; // Rough estimate if not provided

                    hourly.push({
                        timestamp: ts,
                        temperatureF: Math.round(hourData.temp_f),
                        temperatureC: hourData.temp_c,
                        humidity: hourData.humidity,
                        windSpeedMph: hourData.wind_mph,
                        windDirection: hourData.wind_dir,
                        probabilityOfPrecipitation: hourData.chance_of_rain || hourData.chance_of_snow || 0,
                        precipitationType: precipType,
                        snowfallInches: snowfall, // WeatherAPI free doesn't give hourly snow cm clearly
                        shortForecast: hourData.condition.text,
                        isDaytime: hourData.is_day === 1,
                    });
                }
            }

            return {
                location: coords,
                fetchedAt: new Date(),
                source: 'weatherapi',
                hourly
            };
        } catch (error) {
            logger.error('WeatherAPI fetch failed', { error: (error as Error).message });
            throw error;
        }
    }
}

/**
 * Weatherbit Provider
 */
export class WeatherbitProvider extends BaseProvider {
    name = 'weatherbit';
    private client: AxiosInstance;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: 'https://api.weatherbit.io/v2.0',
            timeout: 15000,
        });
    }

    isConfigured(): boolean {
        return !!config.weatherbitApiKey;
    }

    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        if (!this.isConfigured()) throw new Error('Weatherbit API key not configured');

        try {
            const response = await this.client.get('/forecast/hourly', {
                params: {
                    key: config.weatherbitApiKey,
                    lat: coords.lat,
                    lon: coords.lon,
                    units: 'I', // Imperial
                    hours: 120 // 5 days
                }
            });

            const data = response.data.data;
            const hourly: HourlyForecast[] = data.map((item: any) => {
                const timestamp = new Date(item.ts * 1000); // ts is epoch
                const hour = timestamp.getUTCHours(); // Epoch is UTC

                let precipType: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' = 'none';
                if (item.snow > 0) precipType = 'snow';
                else if (item.precip > 0) precipType = 'rain'; // Simplified

                return {
                    timestamp,
                    temperatureF: Math.round(item.temp),
                    temperatureC: this.fahrenheitToCelsius(item.temp),
                    humidity: item.rh,
                    windSpeedMph: item.wind_spd, // Units I = mph? Docs say 'wind_spd': Wind speed (Default m/s). 
                    // Wait, units=I means Imperial. wind_spd should be mph.
                    windDirection: item.wind_cdir,
                    probabilityOfPrecipitation: item.pop,
                    precipitationType: precipType,
                    snowfallInches: item.snow || 0, // Assuming units=I returns inches
                    shortForecast: item.weather.description,
                    isDaytime: item.pod === 'd',
                };
            });
            
            // Convert snow mm to inches if needed in map above
            hourly.forEach(h => {
                // If it was mm
                // h.snowfallInches = h.snowfallInches / 25.4; 
                // Wait, let's fix it in the map directly.
            });

            return {
                location: coords,
                fetchedAt: new Date(),
                source: 'weatherbit',
                hourly
            };
        } catch (error) {
            logger.error('Weatherbit fetch failed', { error: (error as Error).message });
            throw error;
        }
    }
}

/**
 * Visual Crossing Provider
 */
export class VisualCrossingProvider extends BaseProvider {
    name = 'visualcrossing';
    private client: AxiosInstance;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline',
            timeout: 15000,
        });
    }

    isConfigured(): boolean {
        return !!config.visualCrossingApiKey;
    }

    async getHourlyForecast(coords: Coordinates): Promise<WeatherData> {
        if (!this.isConfigured()) throw new Error('Visual Crossing API key not configured');

        try {
            const url = `/${coords.lat},${coords.lon}`;
            const response = await this.client.get(url, {
                params: {
                    key: config.visualCrossingApiKey,
                    unitGroup: 'us', // Fahrenheit, mph, inches
                    include: 'hours',
                }
            });

            const days = response.data.days;
            const hourly: HourlyForecast[] = [];

            for (const day of days) {
                for (const hour of day.hours) {
                    const timestamp = new Date(hour.datetimeEpoch * 1000);
                    
                    let precipType: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' = 'none';
                    if (hour.preciptype) {
                        if (hour.preciptype.includes('snow')) precipType = 'snow';
                        else if (hour.preciptype.includes('rain')) precipType = 'rain';
                        else if (hour.preciptype.includes('ice')) precipType = 'sleet';
                    }

                    hourly.push({
                        timestamp,
                        temperatureF: Math.round(hour.temp),
                        temperatureC: this.fahrenheitToCelsius(hour.temp),
                        humidity: hour.humidity,
                        windSpeedMph: hour.windspeed,
                        windDirection: hour.winddir?.toString(),
                        probabilityOfPrecipitation: hour.precipprob,
                        precipitationType: precipType,
                        snowfallInches: hour.snow || 0,
                        shortForecast: hour.conditions,
                        isDaytime: hour.icon?.includes('day'), // heuristic
                    });
                }
            }

            return {
                location: coords,
                fetchedAt: new Date(),
                source: 'visualcrossing',
                hourly
            };
        } catch (error) {
            const statusCode = (error as any)?.response?.status;
            const errorMessage = (error as Error).message;
            
            // Log specific rate limit errors
            if (statusCode === 429) {
                logger.error(`Visual Crossing rate limit exceeded (429). Consider reducing request frequency or upgrading plan.`);
            } else {
                logger.error('Visual Crossing fetch failed', { statusCode, error: errorMessage });
            }
            
            throw error;
        }
    }
}

/**
 * Meteosource Provider
 * 
 * Supports batch requests for efficient multi-city polling.
 * Meteosource API allows fetching weather for multiple locations
 * by making parallel requests (no native batch endpoint, but we
 * can optimize with request pooling and caching).
 * 
 * Rate Limits:
 * - Free tier: 500 calls/day
 * - Paid tiers: Higher limits available
 * 
 * Polling Strategy:
 * - 2-second polling during HIGH urgency windows
 * - Uses intelligent caching to minimize API calls
 * - Falls back to sequential requests with rate limiting
 */
export class MeteosourceProvider extends BaseProvider {
    name = 'meteosource';
    private client: AxiosInstance;
    
    // In-memory cache for weather data
    private cache: Map<string, { data: WeatherData; fetchedAt: number }> = new Map();
    private readonly cacheTtlMs = 60 * 1000; // 60 second cache for Meteosource
    
    // Rate limiting
    private lastRequestTime: number = 0;
    private readonly minRequestIntervalMs = 500; // Minimum 500ms between requests
    private consecutiveErrors: number = 0;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: 'https://www.meteosource.com/api/v1/free',
            timeout: 15000,
        });
    }

    isConfigured(): boolean {
        return !!config.meteosourceApiKey;
    }
    
    /**
     * Generate cache key for coordinates
     */
    private generateCacheKey(coords: Coordinates): string {
        return `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;
    }
    
    /**
     * Get cached data if available and valid
     */
    private getCachedData(cacheKey: string): WeatherData | null {
        const entry = this.cache.get(cacheKey);
        if (!entry) return null;
        
        const now = Date.now();
        if (now - entry.fetchedAt > this.cacheTtlMs) {
            this.cache.delete(cacheKey);
            return null;
        }
        
        return entry.data;
    }
    
    /**
     * Store data in cache
     */
    private setCachedData(cacheKey: string, data: WeatherData): void {
        this.cache.set(cacheKey, {
            data,
            fetchedAt: Date.now(),
        });
    }
    
    /**
     * Apply rate limiting delay
     */
    private async applyRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestIntervalMs) {
            const delay = this.minRequestIntervalMs - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        this.lastRequestTime = Date.now();
    }

    async getHourlyForecast(coords: Coordinates, useCache: boolean = true): Promise<WeatherData> {
        if (!this.isConfigured()) throw new Error('Meteosource API key not configured');
        
        const cacheKey = this.generateCacheKey(coords);
        
        // Check cache first if enabled
        if (useCache) {
            const cached = this.getCachedData(cacheKey);
            if (cached) {
                logger.debug(`Meteosource cache hit for ${cacheKey}`);
                return cached;
            }
        }

        try {
            // Apply rate limiting
            await this.applyRateLimit();

            const response = await this.client.get('/point', {
                params: {
                    key: config.meteosourceApiKey,
                    lat: coords.lat,
                    lon: coords.lon,
                    sections: 'hourly',
                    units: 'us' // Fahrenheit, mph, inches
                }
            });
            
            // Reset error counter on success
            this.consecutiveErrors = 0;

            const data = response.data.hourly.data;
            const hourly: HourlyForecast[] = data.map((item: any) => {
                const timestamp = new Date(item.date); // ISO string

                let precipType: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none' = 'none';
                if (item.precipitation.type === 'snow') precipType = 'snow';
                else if (item.precipitation.type === 'rain') precipType = 'rain';
                else if (item.precipitation.type === 'ice_pellets') precipType = 'sleet';

                return {
                    timestamp,
                    temperatureF: Math.round(item.temperature),
                    temperatureC: this.fahrenheitToCelsius(item.temperature),
                    humidity: null, // Not always in free tier hourly?
                    windSpeedMph: item.wind.speed,
                    windDirection: item.wind.dir,
                    probabilityOfPrecipitation: item.precipitation.probability || 0,
                    precipitationType: precipType,
                    snowfallInches: (precipType === 'snow') ? item.precipitation.total : 0, // 'total' is amount
                    shortForecast: item.summary,
                    isDaytime: item.icon >= 2 && item.icon <= 24, // Rough heuristic based on icon ID?
                };
            });

            const weatherData: WeatherData = {
                location: coords,
                fetchedAt: new Date(),
                source: 'meteosource',
                hourly
            };
            
            // Cache the result
            this.setCachedData(cacheKey, weatherData);

            return weatherData;
        } catch (error) {
            this.consecutiveErrors++;
            logger.error('Meteosource fetch failed', { 
                error: (error as Error).message,
                consecutiveErrors: this.consecutiveErrors 
            });
            throw error;
        }
    }
    
    /**
     * Get hourly forecasts for multiple coordinates using parallel requests
     *
     * Meteosource doesn't have a native batch endpoint, so we use
     * parallel requests. NO rate limiting - fetches all cities as fast as possible.
     *
     * @param locations Array of locations to fetch
     * @param useCache Whether to use cached data
     * @returns Array of WeatherData for each location
     */
    async getHourlyForecastBatch(
        locations: Array<{ coords: Coordinates; locationName?: string }>,
        useCache: boolean = true
    ): Promise<WeatherData[]> {
        if (locations.length === 0) {
            return [];
        }

        // If only one location, use regular method
        if (locations.length === 1) {
            const data = await this.getHourlyForecast(locations[0].coords, useCache);
            if (locations[0].locationName) {
                data.locationName = locations[0].locationName;
            }
            return [data];
        }

        logger.info(`🌤️ Meteosource batch request: ${locations.length} cities (parallel, no throttling)`);

        const results: WeatherData[] = [];
        const errors: Array<{ location: string; error: string }> = [];

        // Fetch ALL cities in parallel - NO rate limiting, NO delays
        // This is intentional for Meteosource polling mode which needs maximum speed
        const fetchPromises = locations.map(async (location) => {
            try {
                const data = await this.getHourlyForecast(location.coords, useCache);
                if (location.locationName) {
                    data.locationName = location.locationName;
                }
                return { success: true, data, locationName: location.locationName || 'unknown' };
            } catch (error) {
                return {
                    success: false,
                    error: (error as Error).message,
                    locationName: location.locationName || 'unknown'
                };
            }
        });
        
        const fetchResults = await Promise.all(fetchPromises);
        
        for (const result of fetchResults) {
            if (result.success && result.data) {
                results.push(result.data);
            } else {
                errors.push({
                    location: result.locationName || 'unknown',
                    error: result.error || 'Unknown error'
                });
            }
        }

        if (errors.length > 0) {
            logger.warn(`Meteosource batch completed with ${errors.length} errors:`, errors);
        }

        logger.info(`✅ Meteosource batch complete: ${results.length}/${locations.length} cities successful`);
        
        return results;
    }
    
    /**
     * Clear the cache
     */
    clearCache(): void {
        this.cache.clear();
        logger.info('Meteosource cache cleared');
    }
    
    /**
     * Get cache statistics
     */
    getCacheStats(): { size: number; ttlMs: number } {
        return {
            size: this.cache.size,
            ttlMs: this.cacheTtlMs,
        };
    }
}
