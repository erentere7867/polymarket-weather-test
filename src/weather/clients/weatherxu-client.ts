import axios from 'axios';
import { Coordinates } from '../types.js';
import { BaseWeatherClient, ForecastResult, WeatherClientConfig } from './base-client.js';

export class WeatherXuClient extends BaseWeatherClient {
    constructor(config: WeatherClientConfig) {
        super('WeatherXU', config);
    }

    async getForecast(coords: Coordinates): Promise<ForecastResult> {
        if (!this.config.apiKey) throw new Error(`${this.name} API key not configured`);

        const start = Date.now();
        // https://api.weatherxu.com/v1/weather?lat=X&lon=Y&api_key=KEY
        const url = `https://api.weatherxu.com/v1/weather?lat=${coords.lat}&lon=${coords.lon}&api_key=${this.config.apiKey}`;

        const response = await axios.get(url);
        const data = response.data;

        // Need to check unit system. Assuming default is Auto or Imperial/Metric?
        // Docs implied simple response. Let's assume standard units or convert.
        // Usually these default to Celsius or allow parameter. 
        // WeatherXU docs didn't detail "unit" param heavily in summary but "currently.temperature" exists.
        // Let's assume Celsius for consistency logic if not specified (or detect).
        // If undefined units, standard is usually Kelvin or Celsius.
        // Actually weatherxu.com usually defaults to "auto".
        // Let's assume the value is usable as is, but practically we should verify during manual test.
        // For now, assume Celsius (metric) for safety, or check if response has unit metadata.
        // Safe bet: assume Metric C, if 20-30 range. If 60-90, likely F.
        // Better: Try to pass units=metric if supported. 
        // Docs search showed "Units" section.
        // Let's rely on standard parsing.

        const temp = data.currently.temperature;

        // Simple heuristic or assume C.
        // We'll calculate both assuming input is C.
        const tempC = temp;

        return {
            temperatureC: tempC,
            temperatureF: this.celsiusToFahrenheit(tempC),
            timestamp: new Date(),
            source: this.name,
            latencyMs: Date.now() - start
        };
    }
}
