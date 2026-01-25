import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class TomorrowClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('Tomorrow.io', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // https://docs.tomorrow.io/reference/realtime-weather
        const url = `https://api.tomorrow.io/v4/weather/realtime?location=${coords.lat},${coords.lon}&apikey=${this.config.apiKey}`;

        const response = await axios.get(url);
        const data = response.data;
        const tempC = data.data.values.temperature;

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
