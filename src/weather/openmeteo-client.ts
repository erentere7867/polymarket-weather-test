/**
 * Open-Meteo Weather Client
 * Free, open-source weather API with no API key required
 * https://open-meteo.com/
 * 
 * OPTIMIZATION NOTES:
 * - Open-Meteo forecast models update at fixed intervals (typically every 1-6 hours)
 * - ECMWF IFS: Updates at 00:00, 06:00, 12:00, 18:00 UTC (4x daily)
 * - GFS: Updates at 00:00, 06:00, 12:00, 18:00 UTC (4x daily)
 * - NEMS: Updates every hour
 * - MET Nordic: Updates every hour
 * - Icon-D2: Updates every 3 hours
 * 
 * CACHING STRATEGY:
 * - Cache responses for 30-60 minutes during normal operation
 * - Use model update times to determine optimal polling windows
 * - Implement conditional requests (ETag/If-None-Match) when available
 * - Cache batch responses with composite keys
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { logger } from '../logger.js';
import { Coordinates, WeatherData, HourlyForecast, IWeatherProvider } from './types.js';

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

interface OpenMeteoBatchResponse {
    results: OpenMeteoResponse[];
}

/**
 * Cache entry for weather data with metadata
 */
interface CacheEntry {
    data: WeatherData;
    fetchedAt: Date;
    etag?: string;
    lastModified?: string;
    expiresAt: Date;
    paramsHash: string; // Hash of request parameters
}

/**
 * Model update schedule for major forecast models
 * Times are in UTC
 */
const MODEL_UPDATE_SCHEDULE: Record<string, { hours: number[]; typicalDelayMinutes: number }> = {
    'ecmwf_ifs': { hours: [0, 6, 12, 18], typicalDelayMinutes: 120 }, // ECMWF IFS: 4x daily, ~2h delay
    'gfs': { hours: [0, 6, 12, 18], typicalDelayMinutes: 180 }, // GFS: 4x daily, ~3h delay
    'gfs_graphcast': { hours: [0, 6, 12, 18], typicalDelayMinutes: 60 }, // GFS GraphCast: faster
    'icon': { hours: [0, 6, 12, 18], typicalDelayMinutes: 90 }, // DWD Icon: 4x daily
    'icon_d2': { hours: [0, 3, 6, 9, 12, 15, 18, 21], typicalDelayMinutes: 45 }, // Icon-D2: 8x daily
    'gem': { hours: [0, 6, 12, 18], typicalDelayMinutes: 150 }, // GEM: 4x daily
    'meteofrance': { hours: [0, 6, 12, 18], typicalDelayMinutes: 120 }, // ARPEGE: 4x daily
    'ukmo': { hours: [0, 6, 12, 18], typicalDelayMinutes: 120 }, // UK Met Office: 4x daily
    'jma': { hours: [0, 6, 12, 18], typicalDelayMinutes: 120 }, // JMA: 4x daily
    'nems': { hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], typicalDelayMinutes: 30 }, // NEMS: hourly
    'met_nordic': { hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], typicalDelayMinutes: 30 }, // MET Nordic: hourly
}; // Default cache TTL: 30 minutes
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

// Minimum cache TTL: 5 minutes (to prevent excessive API calls)
const MIN_CACHE_TTL_MS = 5 * 60 * 1000;

// Maximum cache TTL: 2 hours (to ensure data freshness)
const MAX_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // Cache hit/miss statistics for monitoring
interface CacheStats {
    hits: number;
    misses: number;
    conditionalHits: number; // 304 Not Modified responses
    lastPruned: Date;
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

export class OpenMeteoClient implements IWeatherProvider {
    name = 'open-meteo';
    private client: AxiosInstance;

    // In-memory cache for weather data
    private cache: Map<string, CacheEntry> = new Map();
    private cacheStats: CacheStats = {
        hits: 0,
        misses: 0,
        conditionalHits: 0,
        lastPruned: new Date(),
    };

    // Default model to use for update time calculations
    private defaultModel = 'gfs';

    // Rate limit tracking
    private lastRateLimitTime: number | null = null;
    private static readonly RATE_LIMIT_WINDOW_MS = 5000; // 5 second rate limit window

    // Per-city rate limiting to prevent duplicate/overlapping API calls
    private static cityLastCallTime: Map<string, number> = new Map();
    private static readonly MIN_CALL_INTERVAL_MS = 2000; // Minimum 2 seconds between calls for same city

    /**
     * Check if rate limit is currently active
     * @returns true if within the rate limit window
     */
    isRateLimitActive(): boolean {
        if (this.lastRateLimitTime === null) {
            return false;
        }
        const timeSinceRateLimit = Date.now() - this.lastRateLimitTime;
        return timeSinceRateLimit < OpenMeteoClient.RATE_LIMIT_WINDOW_MS;
    }

    /**
     * Record a rate limit event
     */
    private recordRateLimit(): void {
        this.lastRateLimitTime = Date.now();
        logger.warn('OpenMeteo rate limit recorded', {
            lastRateLimitTime: new Date(this.lastRateLimitTime).toISOString(),
        });
    }
    
    constructor() {
        this.client = axios.create({
            baseURL: 'https://api.open-meteo.com/v1',
            timeout: 8000,
        });
        
        // Start periodic cache pruning
        this.startCachePruning();
    }

    /**
     * Check if a city can be called (respects minimum call interval)
     * @param cityKey - Unique identifier for the city (e.g., "lat,lon")
     * @returns true if the city can be called, false if rate limited
     */
    private canCallCity(cityKey: string): boolean {
        const now = Date.now();
        const lastCall = OpenMeteoClient.cityLastCallTime.get(cityKey);
        
        if (!lastCall) {
            return true;
        }
        
        const timeSinceLastCall = now - lastCall;
        return timeSinceLastCall >= OpenMeteoClient.MIN_CALL_INTERVAL_MS;
    }

    /**
     * Record a city call time
     * @param cityKey - Unique identifier for the city
     */
    private recordCityCall(cityKey: string): void {
        OpenMeteoClient.cityLastCallTime.set(cityKey, Date.now());
    }

    /**
     * Get city key from coordinates
     */
    private getCityKey(coords: Coordinates): string {
        return `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;
    }

    isConfigured(): boolean {
        return true; // No key required
    }
    
    /**
     * Generate a cache key from coordinates and parameters
     */
    private generateCacheKey(coords: Coordinates, params?: Record<string, unknown>): string {
        const paramsStr = params ? JSON.stringify(params) : '';
        return `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}:${this.hashString(paramsStr)}`;
    }
    
    /**
     * Generate cache key for batch requests
     */
    private generateBatchCacheKey(locations: Array<{ coords: Coordinates }>): string {
        const coordsHash = locations
            .map(l => `${l.coords.lat.toFixed(4)},${l.coords.lon.toFixed(4)}`)
            .sort()
            .join('|');
        return `batch:${this.hashString(coordsHash)}`;
    }
    
    /**
     * Simple string hash function
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(16);
    }
    
    /**
     * Get the next expected model update time
     * Based on the model's typical update schedule
     */
    getNextModelUpdateTime(model: string = this.defaultModel): Date {
        const schedule = MODEL_UPDATE_SCHEDULE[model] || MODEL_UPDATE_SCHEDULE['gfs'];
        const now = new Date();
        const currentHour = now.getUTCHours();
        const currentMinute = now.getUTCMinutes();
        
        // Find the next update hour
        let nextUpdateHour = schedule.hours.find(h => h > currentHour);
        let nextUpdateDay = now.getUTCDate();
        
        if (nextUpdateHour === undefined) {
            // Next update is tomorrow
            nextUpdateHour = schedule.hours[0];
            nextUpdateDay++;
        }
        
        // Create the next update time with typical delay
        const nextUpdate = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            nextUpdateDay,
            nextUpdateHour,
            schedule.typicalDelayMinutes,
            0
        ));
        
        return nextUpdate;
    }
    
    /**
     * Calculate optimal cache TTL based on model update schedule
     * Returns TTL in milliseconds
     */
    calculateOptimalCacheTTL(model: string = this.defaultModel): number {
        const now = new Date();
        const nextUpdate = this.getNextModelUpdateTime(model);
        const timeUntilUpdate = nextUpdate.getTime() - now.getTime();
        
        // If update is coming soon, cache until shortly after the update
        if (timeUntilUpdate < DEFAULT_CACHE_TTL_MS) {
            // Cache until 10 minutes after the expected update
            return Math.max(timeUntilUpdate + 10 * 60 * 1000, MIN_CACHE_TTL_MS);
        }
        
        // Otherwise use default TTL
        return DEFAULT_CACHE_TTL_MS;
    }
    
    /**
     * Check if cached data is still valid
     */
    private isCacheValid(entry: CacheEntry): boolean {
        return entry.expiresAt.getTime() > Date.now();
    }
    
    /**
     * Get cached data if available and valid
     */
    private getCachedData(cacheKey: string): WeatherData | null {
        const entry = this.cache.get(cacheKey);
        if (!entry) {
            return null;
        }
        
        if (!this.isCacheValid(entry)) {
            this.cache.delete(cacheKey);
            return null;
        }
        
        this.cacheStats.hits++;
        logger.debug(`OpenMeteo cache hit for key: ${cacheKey}`);
        return entry.data;
    }
    
    /**
     * Store data in cache with calculated TTL
     */
    private setCachedData(
        cacheKey: string, 
        data: WeatherData, 
        headers?: Record<string, string>,
        paramsHash?: string
    ): void {
        const ttl = this.calculateOptimalCacheTTL();
        const entry: CacheEntry = {
            data,
            fetchedAt: new Date(),
            etag: headers?.['etag'],
            lastModified: headers?.['last-modified'],
            expiresAt: new Date(Date.now() + ttl),
            paramsHash: paramsHash || '',
        };
        
        this.cache.set(cacheKey, entry);
        logger.debug(`OpenMeteo cached data for key: ${cacheKey}, expires at ${entry.expiresAt.toISOString()}`);
    }
    
    /**
     * Start periodic cache pruning (every 5 minutes)
     */
    private startCachePruning(): void {
        setInterval(() => {
            this.pruneCache();
        }, 5 * 60 * 1000);
    }
    
    /**
     * Remove expired entries from cache
     */
    private pruneCache(): void {
        const now = Date.now();
        let prunedCount = 0;
        
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiresAt.getTime() <= now) {
                this.cache.delete(key);
                prunedCount++;
            }
        }
        
        this.cacheStats.lastPruned = new Date();
        
        if (prunedCount > 0) {
            logger.debug(`OpenMeteo cache pruned ${prunedCount} expired entries, ${this.cache.size} remaining`);
        }
    }
    
    /**
     * Get cache statistics for monitoring
     */
    getCacheStats(): CacheStats & { size: number; hitRate: number } {
        const total = this.cacheStats.hits + this.cacheStats.misses;
        const hitRate = total > 0 ? (this.cacheStats.hits / total) * 100 : 0;
        
        return {
            ...this.cacheStats,
            size: this.cache.size,
            hitRate: Math.round(hitRate * 100) / 100,
        };
    }
    
    /**
     * Clear all cached data
     */
    clearCache(): void {
        this.cache.clear();
        this.cacheStats = {
            hits: 0,
            misses: 0,
            conditionalHits: 0,
            lastPruned: new Date(),
        };
        logger.info('OpenMeteo cache cleared');
    }
    
    /**
     * Make a conditional request using ETag/If-None-Match
     * Returns null if server responds with 304 (Not Modified)
     */
    private async makeConditionalRequest<T>(
        url: string, 
        params: Record<string, unknown>,
        cacheEntry?: CacheEntry
    ): Promise<{ data: T; headers: Record<string, string>; isNotModified: boolean } | null> {
        const requestConfig: Record<string, unknown> = { params };
        
        // Add conditional request headers if we have cached ETag
        if (cacheEntry?.etag) {
            requestConfig.headers = {
                'If-None-Match': cacheEntry.etag,
            };
        } else if (cacheEntry?.lastModified) {
            requestConfig.headers = {
                'If-Modified-Since': cacheEntry.lastModified,
            };
        }
        
        try {
            const response: AxiosResponse<T> = await this.client.get(url, requestConfig);
            
            return {
                data: response.data,
                headers: response.headers as Record<string, string>,
                isNotModified: false,
            };
        } catch (error) {
            // Check for 304 Not Modified
            if (axios.isAxiosError(error) && error.response?.status === 304) {
                this.cacheStats.conditionalHits++;
                logger.debug('OpenMeteo returned 304 Not Modified, using cached data');
                return {
                    data: null as unknown as T,
                    headers: error.response.headers as Record<string, string>,
                    isNotModified: true,
                };
            }
            throw error;
        }
    }

    /**
     * Get hourly forecast for coordinates
     * Uses intelligent caching to minimize API calls
     * 
     * CRITICAL LATENCY REQUIREMENT:
     * - During HIGH/MEDIUM urgency windows: pass useCache=false for sub-5-second reaction time
     * - During LOW urgency / burst mode: pass useCache=false to detect forecast changes immediately
     * - Cache is only used during idle WebSocket rest periods to conserve API calls
     */
    async getHourlyForecast(coords: Coordinates, useCache: boolean = true): Promise<WeatherData> {
        // Check if rate limit is active
        if (this.isRateLimitActive()) {
            const cacheKey = this.generateCacheKey(coords, {
                latitude: coords.lat,
                longitude: coords.lon,
                hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_direction_10m',
                temperature_unit: 'fahrenheit',
                wind_speed_unit: 'mph',
                forecast_days: 7,
            });
            const cached = this.cache.get(cacheKey);
            if (cached) {
                logger.warn('Rate limit active, returning cached data', { coords });
                return cached.data;
            }
            throw new Error('Rate limit active and no cached data available');
        }

        // Check per-city rate limit (minimum 2 seconds between calls for same city)
        const cityKey = this.getCityKey(coords);
        if (!this.canCallCity(cityKey)) {
            // Return cached data if available, otherwise throw
            const cacheKey = this.generateCacheKey(coords, {
                latitude: coords.lat,
                longitude: coords.lon,
                hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_direction_10m',
                temperature_unit: 'fahrenheit',
                wind_speed_unit: 'mph',
                forecast_days: 7,
            });
            const cached = this.cache.get(cacheKey);
            if (cached) {
                logger.warn('Per-city rate limit active, returning cached data', { coords });
                return cached.data;
            }
            throw new Error(`Per-city rate limit active for ${cityKey} and no cached data available`);
        }

        const params = {
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
        };
        
        const cacheKey = this.generateCacheKey(coords, params);
        
        // Check cache first if enabled
        if (useCache) {
            const cached = this.getCachedData(cacheKey);
            if (cached) {
                return cached;
            }
        }
        
        this.cacheStats.misses++;
        
        try {
            // Try conditional request if we have cached data with ETag
            const cacheEntry = this.cache.get(cacheKey);
            const result = await this.makeConditionalRequest<OpenMeteoResponse>('/forecast', params, cacheEntry);
            
            if (result === null) {
                // This shouldn't happen with our error handling, but just in case
                throw new Error('Conditional request returned null');
            }
            
            // If 304 Not Modified, return cached data
            if (result.isNotModified && cacheEntry) {
                // Update expiry time since server confirmed data is still valid
                cacheEntry.expiresAt = new Date(Date.now() + this.calculateOptimalCacheTTL());
                return cacheEntry.data;
            }
            
            // Parse and cache the new response
            const weatherData = this.parseWeatherResponse(result.data, coords);
            this.setCachedData(cacheKey, weatherData, result.headers, JSON.stringify(params));
            
            // Record the city call for per-city rate limiting
            this.recordCityCall(cityKey);
            
            return weatherData;
        } catch (error) {
            // If request fails but we have stale cache, use it as fallback
            const staleEntry = this.cache.get(cacheKey);
            if (staleEntry) {
                logger.warn('OpenMeteo request failed, using stale cache', {
                    coords,
                    error: (error as Error).message,
                    cacheAge: Date.now() - staleEntry.fetchedAt.getTime(),
                });
                return staleEntry.data;
            }
            
            logger.error('Failed to fetch Open-Meteo forecast', { coords, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get hourly forecasts for multiple coordinates in a single API call
     * Open-Meteo supports batch requests via the /forecast endpoint with multiple lat/lon pairs
     * 
     * CACHING STRATEGY:
     * - Checks cache for each location individually
     * - Only fetches locations not in cache or with expired cache
     * - Caches the batch result for future requests
     * 
     * CRITICAL LATENCY REQUIREMENT:
     * - During HIGH/MEDIUM urgency windows: pass useCache=false for sub-5-second reaction time
     * - During burst mode: pass useCache=false to detect forecast changes immediately
     * - Cache is only used during idle WebSocket rest periods to conserve API calls
     * 
     * Note: OpenMeteo has rate limits. Large batch requests may trigger 429 errors.
     * If batch fails, we fall back to sequential requests with delays.
     */
    async getHourlyForecastBatch(
        locations: Array<{ coords: Coordinates; locationName?: string }>,
        useCache: boolean = true
    ): Promise<WeatherData[]> {
        if (locations.length === 0) {
            return [];
        }

        // Check if rate limit is active
        if (this.isRateLimitActive()) {
            logger.warn('Rate limit active for batch request, attempting to return cached data');
            const cachedResults: WeatherData[] = [];
            for (const location of locations) {
                const cacheKey = this.generateCacheKey(location.coords, {
                    latitude: location.coords.lat,
                    longitude: location.coords.lon,
                    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_direction_10m',
                    temperature_unit: 'fahrenheit',
                    wind_speed_unit: 'mph',
                    forecast_days: 7,
                });
                const cached = this.cache.get(cacheKey);
                if (cached) {
                    cachedResults.push({
                        ...cached.data,
                        locationName: location.locationName || cached.data.locationName,
                    });
                }
            }
            if (cachedResults.length === locations.length) {
                logger.warn('Rate limit active, returning all cached data for batch request');
                return cachedResults;
            }
            throw new Error('Rate limit active and not all locations have cached data');
        }

        // If only one location, use regular endpoint with caching
        if (locations.length === 1) {
            const data = await this.getHourlyForecast(locations[0].coords, useCache);
            if (locations[0].locationName) {
                data.locationName = locations[0].locationName;
            }
            return [data];
        }

        // Check cache for each location individually
        const cacheKey = this.generateBatchCacheKey(locations);
        
        if (useCache) {
            // Try to get from batch cache first
            const cachedBatch = this.getCachedData(cacheKey);
            if (cachedBatch) {
                // Batch cache hit - return all cached data
                // We need to return array format, so check if cached data is in correct format
                const cachedArray = Array.isArray(cachedBatch) ? cachedBatch : [cachedBatch];
                if (cachedArray.length === locations.length) {
                    logger.debug(`OpenMeteo batch cache hit for ${locations.length} locations`);
                    return cachedArray.map((data, i) => ({
                        ...data,
                        locationName: locations[i].locationName || data.locationName,
                    }));
                }
            }
            
            // Check individual location caches
            const cachedResults: Map<number, WeatherData> = new Map();
            const uncachedLocations: Array<{ coords: Coordinates; locationName?: string; index: number }> = [];
            
            for (let i = 0; i < locations.length; i++) {
                const location = locations[i];
                const individualParams = {
                    latitude: location.coords.lat,
                    longitude: location.coords.lon,
                    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_direction_10m',
                    temperature_unit: 'fahrenheit',
                    wind_speed_unit: 'mph',
                    forecast_days: 7,
                };
                const individualKey = this.generateCacheKey(location.coords, individualParams);
                const cached = this.getCachedData(individualKey);
                
                if (cached) {
                    cachedResults.set(i, {
                        ...cached,
                        locationName: location.locationName || cached.locationName,
                    });
                } else {
                    uncachedLocations.push({ ...location, index: i });
                }
            }
            
            // If all locations are cached, return combined results
            if (uncachedLocations.length === 0) {
                logger.debug(`All ${locations.length} locations found in individual cache`);
                return locations.map((_, i) => cachedResults.get(i)!);
            }
            
            // If some locations are cached, only fetch uncached ones
            if (uncachedLocations.length < locations.length) {
                logger.debug(`Partial cache hit: ${cachedResults.size} cached, ${uncachedLocations.length} to fetch`);
                
                // Fetch only uncached locations
                const fetchedData = await this.fetchBatchLocations(uncachedLocations);
                
                // Merge cached and fetched results
                const results: WeatherData[] = [];
                let fetchIndex = 0;
                for (let i = 0; i < locations.length; i++) {
                    if (cachedResults.has(i)) {
                        results.push(cachedResults.get(i)!);
                    } else {
                        const data = fetchedData[fetchIndex++];
                        if (data) {
                            results.push({
                                ...data,
                                locationName: locations[i].locationName || data.locationName,
                            });
                        }
                    }
                }
                
                return results;
            }
        }

        // No cache hits - fetch all locations
        this.cacheStats.misses++;
        return this.fetchBatchLocations(locations);
    }
    
    /**
     * Internal method to fetch batch locations from API
     * Optimized for speed: MAX_BATCH_SIZE increased to 50, delays removed
     */
    private async fetchBatchLocations(
        locations: Array<{ coords: Coordinates; locationName?: string; index?: number }>
    ): Promise<WeatherData[]> {
        // Open-Meteo supports up to 50 locations per batch request
        const MAX_BATCH_SIZE = 50;
        if (locations.length > MAX_BATCH_SIZE) {
            logger.warn(`Batch size ${locations.length} exceeds max ${MAX_BATCH_SIZE}, splitting into chunks`);
            const results: WeatherData[] = [];
            for (let i = 0; i < locations.length; i += MAX_BATCH_SIZE) {
                const chunk = locations.slice(i, i + MAX_BATCH_SIZE);
                const chunkResults = await this.fetchBatchLocations(chunk);
                results.push(...chunkResults);
                // No delay between chunks for maximum speed
            }
            return results;
        }

        try {
            // Build batch request parameters
            const latitudes = locations.map(l => l.coords.lat).join(',');
            const longitudes = locations.map(l => l.coords.lon).join(',');
            
            const params = {
                latitude: latitudes,
                longitude: longitudes,
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
            };

            const response = await this.client.get<OpenMeteoBatchResponse>('/forecast', { params });

            // Parse each result
            const results: WeatherData[] = [];
            for (let i = 0; i < response.data.results.length; i++) {
                const result = response.data.results[i];
                const location = locations[i];
                const weatherData = this.parseWeatherResponse(result, location.coords);
                if (location.locationName) {
                    weatherData.locationName = location.locationName;
                }
                results.push(weatherData);
                
                // Cache individual location
                const individualKey = this.generateCacheKey(location.coords, params);
                this.setCachedData(individualKey, weatherData, response.headers as Record<string, string>);
                
                // Record city call for per-city rate limiting
                this.recordCityCall(this.getCityKey(location.coords));
            }

            // Also cache the batch result
            const batchKey = this.generateBatchCacheKey(locations.map(l => ({ coords: l.coords })));
            const batchData: WeatherData = {
                ...results[0],
                locationName: `batch:${locations.length}`,
            };
            this.setCachedData(batchKey, batchData, response.headers as Record<string, string>);

            logger.info(`OpenMeteo batch fetch: ${locations.length} locations in 1 API call`);
            return results;
        } catch (error) {
            const statusCode = (error as any)?.response?.status;
            logger.error('Failed to fetch Open-Meteo batch forecast', { 
                count: locations.length, 
                statusCode,
                error: (error as Error).message 
            });
            
            // If rate limited, record the event and wait before falling back
            if (statusCode === 429) {
                this.recordRateLimit();
                logger.warn('OpenMeteo rate limited (429), waiting 2s before fallback');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Fall back to sequential requests without delays for maximum speed
            // Rate limit tracking is kept as a safety net
            logger.warn('Falling back to sequential API calls');
            const results: WeatherData[] = [];
            for (const location of locations) {
                try {
                    const data = await this.getHourlyForecast(location.coords, false); // Don't use cache in fallback
                    if (location.locationName) {
                        data.locationName = location.locationName;
                    }
                    results.push(data);
                    // No delay between requests for maximum speed
                } catch (e) {
                    logger.error(`Failed to fetch ${location.locationName || 'location'}`, { error: (e as Error).message });
                    throw e; // Re-throw to trigger outer fallback
                }
            }
            return results;
        }
    }

    /**
     * Parse OpenMeteo response into WeatherData
     */
    private parseWeatherResponse(data: OpenMeteoResponse, coords: Coordinates): WeatherData {
        const hourly: HourlyForecast[] = [];

        // Debug log raw data
        if (data.hourly && data.hourly.temperature_2m) {
            logger.debug(`OpenMeteo Raw Data for ${coords.lat},${coords.lon}:`, {
                firstTime: data.hourly.time[0],
                firstTemp: data.hourly.temperature_2m[0],
                sampleTemps: data.hourly.temperature_2m.slice(0, 5),
                tempUnit: 'fahrenheit'
            });
        } else {
            logger.error(`OpenMeteo Raw Data Missing!`, { keys: Object.keys(data.hourly || {}) });
        }

        for (let i = 0; i < data.hourly.time.length; i++) {
            // Open-Meteo returns UTC by default (ISO 8601 without offset)
            // We must append 'Z' to force UTC parsing, otherwise Date() assumes local time
            const timeStr = data.hourly.time[i].endsWith('Z') ? data.hourly.time[i] : `${data.hourly.time[i]}Z`;
            const timestamp = new Date(timeStr);
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
                snowfallInches: data.hourly.snowfall[i] ? data.hourly.snowfall[i] / 2.54 : 0,
                shortForecast: WEATHER_CODE_MAP[data.hourly.weather_code[i]] || 'Unknown',
                isDaytime: hour >= 6 && hour < 18,
            });
        }

        // Debug log to verify time range
        if (hourly.length > 0) {
            logger.debug(`OpenMeteo fetched ${hourly.length} hours. Range: ${hourly[0].timestamp.toISOString()} to ${hourly[hourly.length-1].timestamp.toISOString()}`);
        }

        return {
            location: coords,
            locationName: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
            fetchedAt: new Date(),
            source: 'open-meteo',
            hourly,
        };
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

        if (dayTemps.length === 0) {
            logger.warn(`OpenMeteo: No temp data for ${targetDate} at ${coords.lat},${coords.lon}. Available range: ${weather.hourly[0]?.timestamp.toISOString()} - ${weather.hourly[weather.hourly.length-1]?.timestamp.toISOString()}`);
            return null;
        }
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
                // Ensure UTC parsing here as well
                const timeStr = data.hourly.time[i].endsWith('Z') ? data.hourly.time[i] : `${data.hourly.time[i]}Z`;
                const timestamp = new Date(timeStr);
                
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
