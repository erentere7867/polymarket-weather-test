import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class MeteosourceClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('Meteosource', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // https://www.meteosource.com/api/v1/free/point?lat=X&lon=Y&key=KEY
        const url = `https://www.meteosource.com/api/v1/free/point?lat=${coords.lat}&lon=${coords.lon}&key=${this.config.apiKey}`;

        const response = await axios.get(url);
        const data = response.data;
        const tempC = data.current.temperature;

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
