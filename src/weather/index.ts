import { WeatherData, HourlyForecast, Coordinates, findCity } from './types.js';
import { exceedanceProbability } from '../probability/normal-cdf.js';
import { logger } from '../logger.js';
import { DataStore } from '../realtime/data-store.js';

export { FileBasedIngestion } from './file-based-ingestion.js';
export { ScheduleManager } from './schedule-manager.js';
export { S3FileDetector } from './s3-file-detector.js';
export { GRIB2Parser } from './grib2-parser.js';
export { ConfirmationManager } from './confirmation-manager.js';

export { type WeatherData, type HourlyForecast, type Coordinates };

export class WeatherService {
    private dataStore: DataStore | null = null;

    constructor(dataStore?: DataStore) {
        this.dataStore = dataStore || null;
    }

    public setDataStore(store: DataStore): void {
        this.dataStore = store;
    }

    async getExpectedHigh(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateHigh(data, date);
        }

        logger.warn(`[WeatherService] No cached data for ${cityName}, returning null for getExpectedHigh`);
        return null;
    }

    async getExpectedLow(cityName: string, date: Date): Promise<number | null> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateLow(data, date);
        }

        logger.warn(`[WeatherService] No cached data for ${cityName}, returning null for getExpectedLow`);
        return null;
    }

    async getExpectedSnowfall(cityName: string, date: Date, endDate: Date): Promise<number> {
        const city = findCity(cityName);
        if (!city) {
            throw new Error(`Unknown city: ${cityName}`);
        }

        const data = await this.getCachedWeatherData(cityName);
        if (data) {
            return WeatherService.calculateSnowfall(data, date, endDate);
        }

        logger.warn(`[WeatherService] No cached data for ${cityName}, returning 0 for getExpectedSnowfall`);
        return 0;
    }

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

        const markets = this.dataStore.getAllMarkets();
        const matchingMarket = markets.find(m => {
            const marketCityId = m.city?.toLowerCase().replace(/\s+/g, '_');
            return marketCityId === cityId;
        });

        if (!matchingMarket) {
            logger.debug(`[WeatherService] No market found for city: ${cityName}`);
            return null;
        }

        const marketState = this.dataStore.getMarketState(matchingMarket.market.id);
        if (!marketState?.lastForecast?.weatherData) {
            logger.debug(`[WeatherService] No forecast data in cache for market: ${matchingMarket.market.id}`);
            return null;
        }

        return marketState.lastForecast.weatherData;
    }

    static calculateHigh(data: WeatherData, date: Date): number | null {
        const targetDateObj = new Date(date);
        targetDateObj.setUTCHours(0, 0, 0, 0);
        const targetDateStr = targetDateObj.toISOString().split('T')[0];

        const dayTemps = data.hourly
            .filter(h => {
                const hourDate = new Date(h.timestamp);
                return hourDate.toISOString().split('T')[0] === targetDateStr;
            })
            .map(h => h.temperatureF);

        if (dayTemps.length === 0) return null;
        return Math.max(...dayTemps);
    }

    static calculateLow(data: WeatherData, date: Date): number | null {
        const targetDateObj = new Date(date);
        targetDateObj.setUTCHours(0, 0, 0, 0);
        const targetDateStr = targetDateObj.toISOString().split('T')[0];

        const dayTemps = data.hourly
            .filter(h => {
                const hourDate = new Date(h.timestamp);
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

    calculateTempExceedsProbability(forecastTemp: number, threshold: number, uncertainty: number = 3): number {
        return exceedanceProbability(forecastTemp, threshold, uncertainty);
    }

    calculateTempBelowProbability(forecastTemp: number, threshold: number, uncertainty: number = 3): number {
        return 1 - this.calculateTempExceedsProbability(forecastTemp, threshold, uncertainty);
    }
}
