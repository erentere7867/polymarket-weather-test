import { IWeatherProvider } from './types.js';
import { OpenMeteoClient } from './openmeteo-client.js';
import { OpenWeatherClient } from './openweather-client.js';
import { 
    TomorrowProvider, 
    WeatherAPIProvider, 
    WeatherbitProvider, 
    VisualCrossingProvider, 
    MeteosourceProvider 
} from './additional-providers.js';
import { logger } from '../logger.js';

export class WeatherProviderManager {
    private providers: IWeatherProvider[] = [];
    private providerIndex: number = 0;

    constructor() {
        this.initializeProviders();
    }

    private initializeProviders() {
        // OpenMeteo is always available (no key)
        this.providers.push(new OpenMeteoClient());

        // OpenWeatherMap
        const openWeather = new OpenWeatherClient();
        if (openWeather.isConfigured()) this.providers.push(openWeather);

        // Add others if configured
        const tomorrow = new TomorrowProvider();
        if (tomorrow.isConfigured()) this.providers.push(tomorrow);

        const weatherApi = new WeatherAPIProvider();
        if (weatherApi.isConfigured()) this.providers.push(weatherApi);

        const weatherbit = new WeatherbitProvider();
        if (weatherbit.isConfigured()) this.providers.push(weatherbit);

        const visualCrossing = new VisualCrossingProvider();
        if (visualCrossing.isConfigured()) this.providers.push(visualCrossing);

        const meteosource = new MeteosourceProvider();
        if (meteosource.isConfigured()) this.providers.push(meteosource);

        logger.info(`Initialized WeatherProviderManager with ${this.providers.length} providers: ${this.providers.map(p => p.name).join(', ')}`);
    }

    /**
     * Get a provider.
     * If seed is provided, returns a deterministic provider based on the seed (sticky).
     * If offset is provided, it shifts the selection (useful for retries).
     */
    public getProvider(seed?: string, offset: number = 0): IWeatherProvider {
        if (this.providers.length === 0) {
            throw new Error('No weather providers available!');
        }

        if (seed) {
            const hash = this.hashString(seed);
            // Use hash + offset to select provider
            const index = (hash + offset) % this.providers.length;
            // Ensure positive index
            const normalizedIndex = (index + this.providers.length) % this.providers.length;
            return this.providers[normalizedIndex];
        }

        // Fallback to manual rotation (stateful)
        return this.providers[this.providerIndex];
    }

    private hashString(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Manual rotation (keeps existing behavior for global rotation if needed)
     */
    public rotateNow(): void {
        const prevIndex = this.providerIndex;
        this.providerIndex = (this.providerIndex + 1) % this.providers.length;
        if (this.providerIndex !== prevIndex) {
            logger.debug(`Rotated weather provider to: ${this.providers[this.providerIndex].name}`);
        }
    }

    /**
     * Get total number of active providers
     */
    public getProviderCount(): number {
        return this.providers.length;
    }

    /**
     * Get the name of the currently selected provider
     */
    public getCurrentProviderName(): string {
        return this.providers[this.providerIndex]?.name || 'none';
    }
}