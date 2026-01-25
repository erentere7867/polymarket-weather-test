import { EventEmitter } from 'events';
import { WeatherClient, ForecastResult } from '../weather/clients/base-client.js';
import { RateLimiter } from './rate-limiter.js';
import { Coordinates } from '../weather/types.js';
import { logger } from '../logger.js';

interface SourceState {
    lastValue: number;     // Last forecast value
    lastUpdated: Date;     // When we polled
    source: string;
}

export class MultiSourceMonitor extends EventEmitter {
    private sources: WeatherClient[] = [];
    private rateLimiter: RateLimiter;
    private sourceStates: Map<string, Map<string, SourceState>> = new Map(); // city -> source -> state
    private pollIndex: number = 0;
    private internationalCities: string[] = []; // List of cities to monitor

    constructor(rateLimiter: RateLimiter) {
        super();
        this.rateLimiter = rateLimiter;
    }

    addSource(source: WeatherClient): void {
        this.sources.push(source);
    }

    setCities(cities: string[]): void {
        this.internationalCities = cities;
    }

    /**
     * Fail-fast Round-Robin: poll next source, if fails, try next IMMEDIATELY
     */
    async pollNext(getCoordsForCity: (city: string) => Promise<Coordinates | null>): Promise<void> {
        if (this.sources.length === 0 || this.internationalCities.length === 0) return;

        let attempts = 0;
        const maxAttempts = this.sources.length;

        while (attempts < maxAttempts) {
            const source = this.sources[this.pollIndex % this.sources.length];
            this.pollIndex++; // Move index for next call

            // skip if rate limited or not configured
            if (!source.isConfigured() || !this.rateLimiter.canCall(source.name)) {
                attempts++;
                continue;
            }

            try {
                // Poll all international cities with this source
                for (const city of this.internationalCities) {
                    const coords = await getCoordsForCity(city);
                    if (!coords) continue;

                    this.rateLimiter.increment(source.name);
                    const result = await source.getForecast(coords);

                    this.checkForChange(city, source.name, result);
                }

                // Success! We polled valid source this cycle.
                return;
            } catch (error) {
                attempts++;
                logger.warn(`Source ${source.name} failed, skipping to next immediately:`, { error: (error as Error).message });
                // Loop continues immediately to try next source
            }
        }

        logger.warn("All weather sources failed or skipped this poll cycle (check configuration/limits).");
    }

    private checkForChange(city: string, sourceName: string, result: ForecastResult): void {
        if (!this.sourceStates.has(city)) {
            this.sourceStates.set(city, new Map());
        }

        const cityStates = this.sourceStates.get(city)!;
        const previousState = cityStates.get(sourceName);

        // Update state
        cityStates.set(sourceName, {
            lastValue: result.temperatureF,
            lastUpdated: new Date(),
            source: sourceName
        });

        // Trigger change event if significant change or first run?
        // Logic: if ANY source reports a change compared to ITS OWN last value?
        // Or compared to "consensus"? 
        // Plan: "If ANY source reports a change -> emit signal"
        // This usually means relative to its own history.

        if (previousState) {
            const diff = Math.abs(result.temperatureF - previousState.lastValue);
            if (diff >= 1.0) {
                logger.info(`🚨 Forecast CHANGE detected by ${sourceName} for ${city}: ${previousState.lastValue.toFixed(1)} -> ${result.temperatureF.toFixed(1)}°F`);
                this.emit('forecast-changed', {
                    city,
                    source: sourceName,
                    oldValue: previousState.lastValue,
                    newValue: result.temperatureF,
                    timestamp: new Date(),
                    fullResult: result
                });
            }
        } else {
            // First data point for this source
            logger.debug(`Initial forecast from ${sourceName} for ${city}: ${result.temperatureF.toFixed(1)}°F`);
        }
    }
}
