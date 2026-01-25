import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class WeatherbitClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('Weatherbit', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // https://api.weatherbit.io/v2.0/forecast/hourly
        // 48 hour forecast
        const url = `https://api.weatherbit.io/v2.0/forecast/hourly?lat=${coords.lat}&lon=${coords.lon}&key=${this.config.apiKey}&hours=24`;

        const response = await axios.get(url);
        const data = response.data;

        // Get max temp from next 24h as proxy for "high" 
        // Or just first hour? Stick to logic: we want "today's high" usually.
        // But simplified: getting next hour's temp is safest "current" forecast.
        const nextHour = data.data[0];
        const tempC = nextHour.temp;

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
