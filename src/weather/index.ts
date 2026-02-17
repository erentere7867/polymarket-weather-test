/**
 * Weather Service - aggregates weather data from multiple sources
 * Implements robust round-robin provider rotation and standardized data processing.
 * Supports batch fetching for efficient API usage.
 */

import { NOAAClient } from './noaa-client.js';
import { WeatherProviderManager } from './provider-manager.js';
import { WeatherData, HourlyForecast, Coordinates, CityLocation, KNOWN_CITIES, findCity } from './types.js';
import { exceedanceProbability } from '../probability/normal-cdf.js';
import { logger } from '../logger.js';
import { DataStore } from '../realtime/data-store.js';

// Export file-based ingestion components
export { FileBasedIngestion } from './file-based-ingestion.js';
export { ScheduleManager } from './schedule-manager.js';
export { S3FileDetector } from './s3-file-detector.js';
export { GRIB2Parser } from './grib2-parser.js';
export { ApiFallbackPoller } from './api-fallback-poller.js';
export { ConfirmationManager } from './confirmation-manager.js';

// Export types
export { type WeatherData, type HourlyForecast, type Coordinates };

export class WeatherService {
    private noaaClient: NOAAClient;
    private providerManager: WeatherProviderManager;
    private dataStore: DataStore | null = null;

    // US bounding box (rough)
    private readonly US_BOUNDS = {
        minLat: 24.5,
        maxLat: 49.0,
        minLon: -125.0,
        maxLon: -66.5,
    };

    constructor(dataStore?: DataStore) {
        this.noaaClient = new NOAAClient();
        this.providerManager = new WeatherProviderManager();
        this.dataStore = dataStore || null;
    }

    /**
     * Set the DataStore instance for reading cached forecasts
     */
    public setDataStore(store: DataStore): void {
        this.dataStore = store;
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
     * Implements rate limiting and exponential backoff.
     * 
     * DISABLED: API call commented out for file-ingestion-only mode
     */
    async getForecast(coords: Coordinates, country?: string): Promise<WeatherData> {
        // DISABLED: API call commented out for file-ingestion-only mode
        // File-based ingestion is the primary data source; API calls are disabled
        throw new Error('Weather API calls are disabled - use file-based ingestion instead');
        
        // DISABLED: API call logic commented out
        // // Fast path: Try NOAA for US locations (free and authoritative)
        // if (this.isInUS(coords, country)) {
        //     try {
        //         // Enforce rate limit for NOAA
        //         await this.providerManager.enforceRateLimit('noaa');
        //         const noaaPromise = this.noaaClient.getHourlyForecast(coords);
        //         const timeoutPromise = new Promise<never>((_, reject) =>
        //             setTimeout(() => reject(new Error('NOAA timeout')), 3000)
        //         );
        //         const result = await Promise.race([noaaPromise, timeoutPromise]);
        //         this.providerManager.recordSuccess('noaa');
        //         return result;
        //     } catch (error) {
        //         const statusCode = (error as any)?.response?.status;
        //         this.providerManager.recordError('noaa', statusCode);
        //         // Silently fail and move to next provider
        //     }
        // }
        // 
        // // Use global provider manager with rate limiting
        // const attempts = Math.min(this.providerManager.getProviderCount(), 3); // Max 3 attempts
        // 
        // for (let i = 0; i < attempts; i++) {
        //     const provider = this.providerManager.getProvider(undefined, i);
        //     
        //     // Wait if provider is rate limited
        //     await this.providerManager.waitForRateLimit(provider.name);
        //     
        //     // Enforce minimum delay between requests
        //     await this.providerManager.enforceRateLimit(provider.name);
        //     
        //     try {
        //         const providerPromise = provider.getHourlyForecast(coords);
        //         const timeoutPromise = new Promise<never>((_, reject) =>
        //             setTimeout(() => reject(new Error('Provider timeout')), 3000)
        //         );
        //         const result = await Promise.race([providerPromise, timeoutPromise]);
        //         this.providerManager.recordSuccess(provider.name);
        //         return result;
        //     } catch (error) {
        //         const statusCode = (error as any)?.response?.status;
        //         this.providerManager.recordError(provider.name, statusCode);
        //         
        //         // Log rate limit errors
        //         if (statusCode === 429) {
        //             logger.warn(`Provider ${provider.name} returned 429 (rate limited)`);
        //         }
        //         
        //         // Rotate to next provider
        //         this.providerManager.rotateNow();
        //     }
        // }
        // 
        // // Last resort: try OpenMeteo with rate limit check
        // try {
        //     const openMeteo = this.providerManager.getProvider('openmeteo');
        //     await this.providerManager.waitForRateLimit(openMeteo.name);
        //     await this.providerManager.enforceRateLimit(openMeteo.name);
        //     
        //     const providerPromise = openMeteo.getHourlyForecast(coords);
        //     const timeoutPromise = new Promise<never>((_, reject) =>
        //         setTimeout(() => reject(new Error('Final timeout')), 5000)
        //     );
        //     const result = await Promise.race([providerPromise, timeoutPromise]);
        //     this.providerManager.recordSuccess(openMeteo.name);
        //     return result;
        // } catch (error) {
        //     const statusCode = (error as any)?.response?.status;
        //     this.providerManager.recordError('open-meteo', statusCode);
        //     throw new Error('All weather providers failed or timed out');
        // }
    }

    /**
     * Get forecasts for multiple cities in a single batch request
     * This drastically reduces API calls by using OpenMeteo's batch endpoint
     * 
     * DISABLED: API call commented out for file-ingestion-only mode
     */
    async getForecastBatch(cities: Array<{ cityName: string; country?: string }>): Promise<Map<string, WeatherData>> {
        // DISABLED: API call commented out for file-ingestion-only mode
        // File-based ingestion is the primary data source; API calls are disabled
        logger.warn('[WeatherService] getForecastBatch called but API calls are disabled - use file-based ingestion');
        return new Map<string, WeatherData>();
        
        // DISABLED: Batch API call logic commented out
        // const results = new Map<string, WeatherData>();
        // 
        // if (cities.length === 0) {
        //     return results;
        // }
        // 
        // // Separate US cities (use NOAA) from international cities (use batch OpenMeteo)
        // const usCities: Array<{ city: CityLocation; originalName: string }> = [];
        // const intlCities: Array<{ city: CityLocation; originalName: string }> = [];
        // 
        // for (const { cityName, country } of cities) {
        //     const city = findCity(cityName);
        //     if (!city) {
        //         logger.warn(`Unknown city in batch request: ${cityName}`);
        //         continue;
        //     }
        // 
        //     if (this.isInUS(city.coordinates, country || city.country)) {
        //         usCities.push({ city, originalName: cityName });
        //     } else {
        //         intlCities.push({ city, originalName: cityName });
        //     }
        // }
        // 
        // // Fetch US cities using NOAA (sequential with rate limiting - NOAA doesn't support batch)
        // if (usCities.length > 0) {
        //     logger.debug(`Fetching ${usCities.length} US cities via NOAA`);
        //     
        //     // Process sequentially with rate limiting to avoid overwhelming NOAA
        //     for (const { city, originalName } of usCities) {
        //         try {
        //             // Enforce rate limit between NOAA requests
        //             await this.providerManager.enforceRateLimit('noaa');
        //             const data = await this.noaaClient.getHourlyForecast(city.coordinates);
        //             this.providerManager.recordSuccess('noaa');
        //             data.locationName = city.name;
        //             results.set(originalName, data);
        //         } catch (error) {
        //             const statusCode = (error as any)?.response?.status;
        //             this.providerManager.recordError('noaa', statusCode);
        //             logger.warn(`NOAA failed for ${city.name}, falling back to OpenMeteo`);
        //             // Fall back to adding to intl batch
        //             intlCities.push({ city, originalName });
        //         }
        //     }
        // }
        // 
        // // Fetch international cities using OpenMeteo batch endpoint
        // if (intlCities.length > 0) {
        //     logger.debug(`Fetching ${intlCities.length} cities via OpenMeteo batch`);
        //     try {
        //         const openMeteo = this.providerManager.getProvider('openmeteo');
        //         
        //         // Wait for rate limit and enforce minimum delay
        //         await this.providerManager.waitForRateLimit(openMeteo.name);
        //         await this.providerManager.enforceRateLimit(openMeteo.name);
        //         
        //         // Check if OpenMeteo client has batch support
        //         if ('getHourlyForecastBatch' in openMeteo) {
        //             const batchClient = openMeteo as import('./openmeteo-client.js').OpenMeteoClient;
        //             const locations = intlCities.map(({ city }) => ({
        //                 coords: city.coordinates,
        //                 locationName: city.name
        //             }));
        // 
        //             const batchResults = await batchClient.getHourlyForecastBatch(locations);
        //             this.providerManager.recordSuccess(openMeteo.name);
        //             
        //             // Map results back to original city names
        //             for (let i = 0; i < batchResults.length && i < intlCities.length; i++) {
        //                 const { originalName } = intlCities[i];
        //                 results.set(originalName, batchResults[i]);
        //             }
        //         } else {
        //             // Fallback to individual calls with rate limiting
        //             for (const { city, originalName } of intlCities) {
        //                 try {
        //                     await this.providerManager.enforceRateLimit(openMeteo.name);
        //                     const data = await openMeteo.getHourlyForecast(city.coordinates);
        //                     this.providerManager.recordSuccess(openMeteo.name);
        //                     data.locationName = city.name;
        //                     results.set(originalName, data);
        //                 } catch (error) {
        //                     const statusCode = (error as any)?.response?.status;
        //                     this.providerManager.recordError(openMeteo.name, statusCode);
        //                     logger.error(`Failed to fetch ${city.name} from OpenMeteo`, { error: (error as Error).message });
        //                 }
        //             }
        //         }
        //     } catch (error) {
        //         logger.error('Batch fetch failed, falling back to individual calls', { error: (error as Error).message });
        //         // Fallback to individual calls
        //         const promises = intlCities.map(async ({ city, originalName }) => {
        //             try {
        //                 const data = await this.getForecast(city.coordinates, city.country);
        //                 return { name: originalName, data };
        //             } catch (e) {
        //                 logger.error(`Failed to fetch ${city.name}`, { error: (e as Error).message });
        //                 return null;
        //             }
        //         });
        // 
        //         const fallbackResults = await Promise.all(promises);
        //         for (const result of fallbackResults) {
        //             if (result) {
        //                 results.set(result.name, result.data);
        //             }
        //         }
        //     }
        // }
        // 
        // return results;
    }

    /**
     * Get forecast by city name
     * DISABLED: API call commented out for file-ingestion-only mode
     */
    async getForecastByCity(cityName: string): Promise<WeatherData> {
        // DISABLED: API call commented out for file-ingestion-only mode
        throw new Error(`Weather API calls are disabled - use file-based ingestion instead (city: ${cityName})`);
        
        // DISABLED: API call logic commented out
        // const city = findCity(cityName);
        // if (!city) {
        //     throw new Error(`Unknown city: ${cityName}`);
        // }
        // return this.getForecast(city.coordinates, city.country);
    }

    /**
     * Get expected high temperature for a city on a specific date
     * Reads from DataStore cache instead of making API calls
     */
    async getExpectedHigh(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        // Try to get data from DataStore cache
        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateHigh(data, date);
        }

        // Fallback: return null if no cached data available
        logger.warn(`[WeatherService] No cached data for ${cityName}, returning null for getExpectedHigh`);
        return null;
    }

    /**
     * Get expected low temperature for a city on a specific date
     * Reads from DataStore cache instead of making API calls
     */
    async getExpectedLow(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        // Try to get data from DataStore cache
        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateLow(data, date);
        }

        // Fallback: return null if no cached data available
        logger.warn(`[WeatherService] No cached data for ${cityName}, returning null for getExpectedLow`);
        return null;
    }

    /**
     * Get expected snowfall for a location over a date range
     * Reads from DataStore cache instead of making API calls
     */
    async getExpectedSnowfall(cityName: string, date: Date, endDate: Date): Promise<number> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        // Try to get data from DataStore cache
        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateSnowfall(data, date, endDate);
        }

        // Fallback: return 0 if no cached data available
        logger.warn(`[WeatherService] No cached data for ${cityName}, returning 0 for getExpectedSnowfall`);
        return 0;
    }

    /**
     * Get cached weather data from DataStore
     * Searches through all markets to find one matching the city name
     */
    private async getCachedWeatherData(cityName: string): Promise<WeatherData | null> {
        if (!this.dataStore) {
            logger.warn('[WeatherService] DataStore not configured, cannot read cached weather data');
            return null;
        }

        const city = findCity(cityName);
        if (!city) {
            return null;
        }

        const cityId = cityName.toLowerCase().replace(/\s+/g, '_');

        // Find markets for this city
        const markets = this.dataStore.getAllMarkets();
        const matchingMarket = markets.find(m => {
            const marketCityId = m.city?.toLowerCase().replace(/\s+/g, '_');
            return marketCityId === cityId;
        });

        if (!matchingMarket) {
            logger.debug(`[WeatherService] No market found for city: ${cityName}`);
            return null;
        }

        // Get the market state to access the forecast
        const marketState = this.dataStore.getMarketState(matchingMarket.market.id);
        if (!marketState?.lastForecast?.weatherData) {
            logger.debug(`[WeatherService] No forecast data in cache for market: ${matchingMarket.market.id}`);
            return null;
        }

        return marketState.lastForecast.weatherData;
    }

    // --- Static Calculation Helpers (Efficient Processing) ---

    static calculateHigh(data: WeatherData, date: Date): number | null {
        // Normalize the target date to YYYY-MM-DD string for comparison
        // This avoids timezone issues with timestamp equality checks
        const targetDateObj = new Date(date);
        targetDateObj.setUTCHours(0, 0, 0, 0);
        const targetDateStr = targetDateObj.toISOString().split('T')[0];

        const dayTemps = data.hourly
            .filter(h => {
                const hourDate = new Date(h.timestamp);
                // Use date string comparison to avoid timestamp mismatch issues
                return hourDate.toISOString().split('T')[0] === targetDateStr;
            })
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    static calculateLow(data: WeatherData, date: Date): number | null {
        // Normalize the target date to YYYY-MM-DD string for comparison
        // This avoids timezone issues with timestamp equality checks
        const targetDateObj = new Date(date);
        targetDateObj.setUTCHours(0, 0, 0, 0);
        const targetDateStr = targetDateObj.toISOString().split('T')[0];

        const dayTemps = data.hourly
            .filter(h => {
                const hourDate = new Date(h.timestamp);
                // Use date string comparison to avoid timestamp mismatch issues
                return hourDate.toISOString().split('T')[0] === targetDateStr;
            })
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
        return exceedanceProbability(forecastTemp, threshold, uncertainty);
    }

    /**
     * Calculate probability that temperature will be below a threshold
     */
    calculateTempBelowProbability(forecastTemp: number, threshold: number, uncertainty: number = 3): number {
        return 1 - this.calculateTempExceedsProbability(forecastTemp, threshold, uncertainty);
    }
}
