import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class VisualCrossingClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('Visual Crossing', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/[location]/[date1]/[date2]?key=YOUR_API_KEY
        // Get today's forecast
        const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${coords.lat},${coords.lon}/today?key=${this.config.apiKey}&unitGroup=metric`;

        const response = await axios.get(url);
        const data = response.data;
        const todayPrice = data.days[0];
        const tempC = todayPrice.tempmax; // Using max temp since metric group requested

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
