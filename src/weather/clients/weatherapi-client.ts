import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class WeatherApiClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('WeatherAPI', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // http://api.weatherapi.com/v1/forecast.json
        const url = `http://api.weatherapi.com/v1/forecast.json?key=${this.config.apiKey}&q=${coords.lat},${coords.lon}&days=1`;

        const response = await axios.get(url);
        const data = response.data;
        // Using forecastday max temp for consistency with logic, or current temp?
        // Logic usually checks daily MAX or current depending on market type.
        // For racing "current" updates, current temp is best proxy for short-term, 
        // but for "high" markets we might want daily high. 
        // Let's grab CURRENT temp for now as it updates most frequently for latency checks.
        // Actually, for "High Temp" markets we need the forecast high.
        // But the prompt was about detecting "forecast changes".
        // Let's fetch current temp as standard "realtime" check, but ideally we'd switch based on market type.
        // Given complexity, let's grab CURRENT temp for "racing" (fastest update signal),
        // or daily forecast max if available.
        // Strategy says: "When ANY source reports a change -> Trade"
        // Most weather APIs update CURRENT conditions fastest.
        // Let's use daily MAX forecast for consistency with market resolution.

        const maxTempF = data.forecast.forecastday[0].day.maxtemp_f;
        const maxTempC = data.forecast.forecastday[0].day.maxtemp_c;

        return {
            temperatureC: maxTempC,
            temperatureF: maxTempF,
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
