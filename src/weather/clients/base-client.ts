import { Coordinates } from '../types.js';

export interface WeatherClientConfig {
    name: string;
    apiKey?: string;
    username?: string; // For Meteomatics
    password?: string; // For Meteomatics
    rateLimit: number; // Max calls per day
    enabled: boolean;
}

export interface ForecastResult {
    temperatureF: number;
    temperatureC: number;
    timestamp: Date;
    source: string;
    latencyMs?: number; // How long the request took
}

export interface WeatherClient {
    name: string;
    config: WeatherClientConfig;

    /**
     * Get current weather forecast for a location
     */
    getForecast(coords: Coordinates): Promise<ForecastResult>;

    /**
     * Check if client is configured and enabled
     */
    isConfigured(): boolean;
}

/**
 * Base abstract class to handle common logic
 */
export abstract class BaseWeatherClient implements WeatherClient {
    name: string;
    config: WeatherClientConfig;

    constructor(name: string, config: WeatherClientConfig) {
        this.name = name;
        this.config = config;
    }

    abstract getForecast(coords: Coordinates): Promise<ForecastResult>;

    isConfigured(): boolean {
        if (!this.config.enabled) return false;

        // Meteomatics relies on username/password
        if (this.name === 'Meteomatics') {
            return !!this.config.username && !!this.config.password;
        }

        // Others rely on API key
        return !!this.config.apiKey;
    }

    protected celsiusToFahrenheit(c: number): number {
        return (c * 9 / 5) + 32;
    }

    protected fahrenheitToCelsius(f: number): number {
        return (f - 32) * 5 / 9;
    }
}
