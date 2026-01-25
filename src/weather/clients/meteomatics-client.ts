import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class MeteomaticsClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('Meteomatics', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.username || !this.config.password) {
            throw new Error(`${this.name} credentials not configured`);
        }

        const start = Date.now();
        const now = new Date().toISOString();
        // https://api.meteomatics.com/TIME/t_2m:C/LAT,LON/json
        const url = `https://api.meteomatics.com/${now}/t_2m:C/${coords.lat},${coords.lon}/json`;

        const response = await axios.get(url, {
            auth: {
                username: this.config.username,
                password: this.config.password
            }
        });

        const data = response.data;
        const tempC = data.data[0].coordinates[0].dates[0].value;

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
