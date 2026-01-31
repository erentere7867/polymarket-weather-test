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

interface RateLimitState {
    lastRequestTime: number;
    consecutiveErrors: number;
    isRateLimited: boolean;
    rateLimitResetTime: number;
}

export class WeatherProviderManager {
    private providers: IWeatherProvider[] = [];
    private providerIndex: number = 0;
    
    // Rate limiting state per provider
    private rateLimitStates: Map<string, RateLimitState> = new Map();
    
    // Global rate limiting config
    private readonly minRequestIntervalMs = 500; // Minimum 500ms between requests to same provider
    private readonly maxConsecutiveErrors = 3;
    private readonly baseBackoffMs = 1000;
    private readonly maxBackoffMs = 30000;

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
     * Get rate limit state for a provider, initializing if needed
     */
    private getRateLimitState(providerName: string): RateLimitState {
        if (!this.rateLimitStates.has(providerName)) {
            this.rateLimitStates.set(providerName, {
                lastRequestTime: 0,
                consecutiveErrors: 0,
                isRateLimited: false,
                rateLimitResetTime: 0,
            });
        }
        return this.rateLimitStates.get(providerName)!;
    }

    /**
     * Check if a provider is currently rate limited
     */
    public isProviderRateLimited(providerName: string): boolean {
        const state = this.getRateLimitState(providerName);
        if (!state.isRateLimited) return false;
        
        // Check if rate limit has expired
        if (Date.now() >= state.rateLimitResetTime) {
            state.isRateLimited = false;
            state.consecutiveErrors = 0;
            return false;
        }
        return true;
    }

    /**
     * Get the time until a provider's rate limit resets
     */
    public getRateLimitResetTime(providerName: string): number {
        const state = this.getRateLimitState(providerName);
        return Math.max(0, state.rateLimitResetTime - Date.now());
    }

    /**
     * Record a successful request to a provider
     */
    public recordSuccess(providerName: string): void {
        const state = this.getRateLimitState(providerName);
        state.lastRequestTime = Date.now();
        state.consecutiveErrors = 0;
        state.isRateLimited = false;
    }

    /**
     * Record a failed request to a provider with exponential backoff
     */
    public recordError(providerName: string, statusCode?: number): void {
        const state = this.getRateLimitState(providerName);
        state.lastRequestTime = Date.now();
        state.consecutiveErrors++;
        
        // If 429 or multiple consecutive errors, apply rate limiting
        if (statusCode === 429 || state.consecutiveErrors >= this.maxConsecutiveErrors) {
            state.isRateLimited = true;
            
            // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
            const backoffMs = Math.min(
                this.baseBackoffMs * Math.pow(2, state.consecutiveErrors - 1),
                this.maxBackoffMs
            );
            
            state.rateLimitResetTime = Date.now() + backoffMs;
            
            logger.warn(`Provider ${providerName} rate limited. Backoff: ${backoffMs}ms (errors: ${state.consecutiveErrors})`);
        }
    }

    /**
     * Wait for rate limit to clear for a provider
     */
    public async waitForRateLimit(providerName: string): Promise<void> {
        const waitTime = this.getRateLimitResetTime(providerName);
        if (waitTime > 0) {
            logger.debug(`Waiting ${waitTime}ms for ${providerName} rate limit to clear`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    /**
     * Enforce minimum delay between requests to the same provider
     */
    public async enforceRateLimit(providerName: string): Promise<void> {
        const state = this.getRateLimitState(providerName);
        const timeSinceLastRequest = Date.now() - state.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestIntervalMs) {
            const delay = this.minRequestIntervalMs - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    /**
     * Get a provider.
     * If seed is provided, returns a deterministic provider based on the seed (sticky).
     * If offset is provided, it shifts the selection (useful for retries).
     * Skips providers that are currently rate limited.
     */
    public getProvider(seed?: string, offset: number = 0, skipRateLimited: boolean = true): IWeatherProvider {
        if (this.providers.length === 0) {
            throw new Error('No weather providers available!');
        }

        // Try to find a non-rate-limited provider
        const maxAttempts = this.providers.length;
        for (let i = 0; i < maxAttempts; i++) {
            let provider: IWeatherProvider;
            
            if (seed) {
                const hash = this.hashString(seed);
                const index = (hash + offset + i) % this.providers.length;
                const normalizedIndex = (index + this.providers.length) % this.providers.length;
                provider = this.providers[normalizedIndex];
            } else {
                const index = (this.providerIndex + offset + i) % this.providers.length;
                provider = this.providers[index];
            }
            
            // Check if provider is rate limited
            if (skipRateLimited && this.isProviderRateLimited(provider.name)) {
                logger.debug(`Skipping rate-limited provider: ${provider.name}`);
                continue;
            }
            
            return provider;
        }
        
        // All providers rate limited, return the first one (will wait before using)
        logger.warn('All providers rate limited, returning first provider');
        return this.providers[0];
    }

    /**
     * Get the next available provider that is not rate limited
     */
    public getNextAvailableProvider(): IWeatherProvider | null {
        for (let i = 0; i < this.providers.length; i++) {
            const provider = this.providers[(this.providerIndex + i) % this.providers.length];
            if (!this.isProviderRateLimited(provider.name)) {
                return provider;
            }
        }
        return null;
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
     * Skips rate-limited providers
     */
    public rotateNow(): void {
        const prevIndex = this.providerIndex;
        
        // Find next non-rate-limited provider
        for (let i = 1; i <= this.providers.length; i++) {
            const nextIndex = (this.providerIndex + i) % this.providers.length;
            const provider = this.providers[nextIndex];
            
            if (!this.isProviderRateLimited(provider.name)) {
                this.providerIndex = nextIndex;
                if (this.providerIndex !== prevIndex) {
                    logger.debug(`Rotated weather provider to: ${provider.name}`);
                }
                return;
            }
        }
        
        // All providers rate limited, just advance one position
        this.providerIndex = (this.providerIndex + 1) % this.providers.length;
        logger.debug(`All providers rate limited, rotated to: ${this.providers[this.providerIndex].name}`);
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