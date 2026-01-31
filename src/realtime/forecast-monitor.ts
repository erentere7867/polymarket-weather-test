/**
 * Forecast Monitor
 * Polls weather APIs and updates DataStore with latest forecasts
 * Supports city priority system for high-volatility markets
 */

import { WeatherService } from '../weather/index.js';
import type { WeatherData } from '../weather/types.js';
import { DataStore } from './data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

interface CityPriority {
    city: string;
    isHighPriority: boolean;
    volatilityScore: number;
    lastForecastChange: Date | null;
    changeHistory: Date[]; // Track timestamps of all changes for time-based analysis
}

export class ForecastMonitor {
    private weatherService: WeatherService;
    private store: DataStore;
    private regularPollIntervalMs: number;
    private highPriorityPollIntervalMs: number;
    private isRunning: boolean = false;
    private regularPollTimeout: NodeJS.Timeout | null = null;
    private highPriorityPollTimeout: NodeJS.Timeout | null = null;
    private cityCache: Map<string, { data: WeatherData, timestamp: Date }> = new Map();
    public cacheTtlMs: number = 0;
    private initializedMarkets: Set<string> = new Set();

    // City priority tracking
    private cityPriorities: Map<string, CityPriority> = new Map();
    private highPriorityCities: Set<string> = new Set();

    // Automatic priority evaluation interval
    private priorityEvaluationIntervalMs: number = 60000; // Every 60 seconds
    private priorityEvaluationTimeout: NodeJS.Timeout | null = null;

    // Callback for significant changes
    public onForecastChanged: ((marketId: string, changeAmount: number) => void) | null = null;

    constructor(store: DataStore, pollIntervalMs?: number, weatherService?: WeatherService) {
        this.store = store;
        this.weatherService = weatherService || new WeatherService();
        // Use config defaults
        this.regularPollIntervalMs = pollIntervalMs ?? config.forecastPollIntervalMs;
        this.highPriorityPollIntervalMs = config.highPriorityPollIntervalMs;
        
        // Initialize high priority cities from config
        this.initializeHighPriorityCities();
        
        logger.info(`ForecastMonitor initialized with ${this.regularPollIntervalMs / 1000}s regular interval, ${this.highPriorityPollIntervalMs / 1000}s high priority interval`);
        logger.info(`High priority cities: ${Array.from(this.highPriorityCities).join(', ') || 'none'}`);
    }

    /**
     * Initialize high priority cities from config
     */
    private initializeHighPriorityCities(): void {
        for (const city of config.highPriorityCities) {
            this.highPriorityCities.add(city.toLowerCase());
        }
    }

    /**
     * Add a city to high priority list
     */
    addHighPriorityCity(city: string): void {
        const normalizedCity = city.toLowerCase();
        this.highPriorityCities.add(normalizedCity);
        logger.info(`Added ${city} to high priority cities`);
    }

    /**
     * Remove a city from high priority list
     */
    removeHighPriorityCity(city: string): void {
        const normalizedCity = city.toLowerCase();
        this.highPriorityCities.delete(normalizedCity);
        logger.info(`Removed ${city} from high priority cities`);
    }

    /**
     * Check if a city is high priority
     */
    isHighPriorityCity(city: string): boolean {
        return this.highPriorityCities.has(city.toLowerCase());
    }

    /**
     * Get all high priority cities currently being tracked
     */
    getHighPriorityCities(): string[] {
        return Array.from(this.highPriorityCities);
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Start both polling loops
        this.scheduleRegularPoll();
        this.scheduleHighPriorityPoll();
        
        // Start automatic priority evaluation
        this.schedulePriorityEvaluation();
        
        logger.info('ForecastMonitor started with dual polling and automatic priority evaluation');
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        this.isRunning = false;
        if (this.regularPollTimeout) {
            clearTimeout(this.regularPollTimeout);
            this.regularPollTimeout = null;
        }
        if (this.highPriorityPollTimeout) {
            clearTimeout(this.highPriorityPollTimeout);
            this.highPriorityPollTimeout = null;
        }
        if (this.priorityEvaluationTimeout) {
            clearTimeout(this.priorityEvaluationTimeout);
            this.priorityEvaluationTimeout = null;
        }
        logger.info('ForecastMonitor stopped');
    }

    /**
     * Schedule the next priority evaluation
     */
    private schedulePriorityEvaluation(): void {
        if (!this.isRunning) return;
        this.priorityEvaluationTimeout = setTimeout(() => this.runPriorityEvaluation(), this.priorityEvaluationIntervalMs);
    }

    /**
     * Run priority evaluation and schedule next one
     */
    private runPriorityEvaluation(): void {
        if (!this.isRunning) return;
        
        try {
            this.evaluatePriorityChanges();
        } catch (error) {
            logger.error('Priority evaluation failed', { error: (error as Error).message });
        }
        
        // Schedule next evaluation
        this.schedulePriorityEvaluation();
    }

    /**
     * Update polling intervals dynamically
     */
    updatePollIntervals(regularMs?: number, highPriorityMs?: number): void {
        if (regularMs !== undefined) {
            this.regularPollIntervalMs = regularMs;
            logger.info(`Regular poll interval updated to ${regularMs}ms`);
        }
        if (highPriorityMs !== undefined) {
            this.highPriorityPollIntervalMs = highPriorityMs;
            logger.info(`High priority poll interval updated to ${highPriorityMs}ms`);
        }
        
        // Reset timeouts with new intervals
        if (this.regularPollTimeout) {
            clearTimeout(this.regularPollTimeout);
            this.scheduleRegularPoll();
        }
        if (this.highPriorityPollTimeout) {
            clearTimeout(this.highPriorityPollTimeout);
            this.scheduleHighPriorityPoll();
        }
    }

    /**
     * Get current polling intervals
     */
    getPollIntervals(): { regular: number; highPriority: number } {
        return {
            regular: this.regularPollIntervalMs,
            highPriority: this.highPriorityPollIntervalMs
        };
    }

    /**
     * Schedule the next regular priority poll
     */
    private scheduleRegularPoll(): void {
        if (!this.isRunning) return;
        this.regularPollTimeout = setTimeout(() => this.pollRegular(), this.regularPollIntervalMs);
    }

    /**
     * Schedule the next high priority poll
     */
    private scheduleHighPriorityPoll(): void {
        if (!this.isRunning) return;
        this.highPriorityPollTimeout = setTimeout(() => this.pollHighPriority(), this.highPriorityPollIntervalMs);
    }

    /**
     * Poll regular priority cities
     */
    private async pollRegular(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const markets = this.store.getAllMarkets();
            const regularCities = this.getCitiesByPriority(markets, false);
            
            if (regularCities.size > 0) {
                logger.debug(`Polling ${regularCities.size} regular priority cities`);
                await this.pollCities(regularCities);
            }
        } catch (error) {
            logger.error('Regular priority poll failed', { error: (error as Error).message });
        }

        // Schedule next regular poll
        this.scheduleRegularPoll();
    }

    /**
     * Poll high priority cities
     */
    private async pollHighPriority(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const markets = this.store.getAllMarkets();
            const highPriorityCities = this.getCitiesByPriority(markets, true);
            
            if (highPriorityCities.size > 0) {
                logger.debug(`Polling ${highPriorityCities.size} high priority cities`);
                await this.pollCities(highPriorityCities);
            }
        } catch (error) {
            logger.error('High priority poll failed', { error: (error as Error).message });
        }

        // Schedule next high priority poll
        this.scheduleHighPriorityPoll();
    }

    /**
     * Get cities grouped by priority level
     */
    private getCitiesByPriority(markets: ParsedWeatherMarket[], highPriority: boolean): Map<string, ParsedWeatherMarket[]> {
        const cityGroups = new Map<string, ParsedWeatherMarket[]>();

        for (const market of markets) {
            if (!market.city) continue;
            
            const isHigh = this.isHighPriorityCity(market.city);
            if (isHigh === highPriority) {
                const list = cityGroups.get(market.city) || [];
                list.push(market);
                cityGroups.set(market.city, list);
            }
        }

        return cityGroups;
    }

    /**
     * Poll a set of cities using batch fetching
     */
    private async pollCities(cityGroups: Map<string, ParsedWeatherMarket[]>): Promise<void> {
        const cities = Array.from(cityGroups.keys());
        if (cities.length === 0) return;

        try {
            // Use batch fetching for efficiency
            const batchResults = await this.weatherService.getForecastBatch(
                cities.map(city => ({ cityName: city }))
            );

            // Process each city's results
            const updatePromises = Array.from(cityGroups.entries()).map(([city, cityMarkets]) => {
                const weatherData = batchResults.get(city);
                if (weatherData) {
                    // Update cache
                    this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
                    // Process markets for this city
                    return this.processCityMarkets(city, cityMarkets, weatherData);
                }
                return Promise.resolve();
            });
            await Promise.all(updatePromises);
        } catch (error) {
            logger.error('Batch fetch failed, falling back to individual fetches', { error: (error as Error).message });
            // Fallback to individual fetches
            const updatePromises = Array.from(cityGroups.entries()).map(([city, cityMarkets]) =>
                this.updateCityForecasts(city, cityMarkets).catch(error => {
                    logger.error(`Failed to update forecasts for ${city}`, { error: (error as Error).message });
                })
            );
            await Promise.all(updatePromises);
        }
    }

    /**
     * Get count of changes in the last N hours for a city
     */
    getRecentChangeCount(city: string, hours: number = 1): number {
        const priority = this.cityPriorities.get(city.toLowerCase());
        if (!priority || !priority.changeHistory.length) return 0;
        
        const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
        return priority.changeHistory.filter(timestamp => timestamp >= cutoffTime).length;
    }

    /**
     * Get hours since the last change for a city
     */
    getHoursSinceLastChange(city: string): number | null {
        const priority = this.cityPriorities.get(city.toLowerCase());
        if (!priority || !priority.lastForecastChange) return null;
        
        const now = new Date();
        const diffMs = now.getTime() - priority.lastForecastChange.getTime();
        return diffMs / (1000 * 60 * 60);
    }

    /**
     * Clean up old change history entries (older than 2 hours)
     */
    private cleanupOldChangeHistory(city: string): void {
        const priority = this.cityPriorities.get(city.toLowerCase());
        if (!priority) return;
        
        const cutoffTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
        priority.changeHistory = priority.changeHistory.filter(timestamp => timestamp >= cutoffTime);
        
        // Update volatility score based on remaining changes
        priority.volatilityScore = Math.min(priority.changeHistory.length * 0.5, 10);
    }

    /**
     * Detect high volatility cities based on recent forecast changes
     * This is an optional enhancement that can dynamically adjust priorities
     */
    detectHighVolatilityCities(threshold: number = 2): string[] {
        const volatileCities: string[] = [];
        
        for (const [city, priority] of this.cityPriorities) {
            // Consider a city volatile if it has multiple recent changes in last hour
            const recentChanges = this.getRecentChangeCount(city, 1);
            if (recentChanges >= threshold) {
                volatileCities.push(city);
            }
        }
        
        return volatileCities;
    }

    /**
     * Auto-detect and update high priority cities based on volatility
     * Legacy method - use evaluatePriorityChanges for automatic promotion/demotion
     */
    updatePrioritiesBasedOnVolatility(): void {
        const volatileCities = this.detectHighVolatilityCities();
        
        for (const city of volatileCities) {
            if (!this.isHighPriorityCity(city)) {
                logger.info(`Auto-promoting ${city} to high priority due to volatility`);
                this.addHighPriorityCity(city);
            }
        }
    }

    /**
     * Evaluate and apply automatic priority changes based on forecast change history
     * - Promote to high priority: >2 changes in last hour AND not already high priority
     * - Demote to regular priority: high priority AND no changes in last hour
     */
    evaluatePriorityChanges(): void {
        const now = new Date();
        const promotedCities: string[] = [];
        const demotedCities: string[] = [];

        // Check all cities we have data for
        for (const [city, priority] of this.cityPriorities) {
            const isHighPriority = this.isHighPriorityCity(city);
            const recentChangeCount = this.getRecentChangeCount(city, 1); // Changes in last hour
            const hoursSinceLastChange = this.getHoursSinceLastChange(city);

            // Promotion criteria: >2 changes in last hour AND not high priority
            if (!isHighPriority && recentChangeCount > 2) {
                logger.info(`🚀 PROMOTING ${city} to high priority: ${recentChangeCount} changes in last hour`);
                this.addHighPriorityCity(city);
                priority.isHighPriority = true;
                promotedCities.push(city);
            }
            // Demotion criteria: high priority AND no changes in last hour
            else if (isHighPriority && hoursSinceLastChange !== null && hoursSinceLastChange >= 1) {
                // Only demote if it was auto-promoted (not in config.highPriorityCities)
                const isConfigPriority = config.highPriorityCities.some(
                    c => c.toLowerCase() === city.toLowerCase()
                );
                if (!isConfigPriority) {
                    logger.info(`📉 DEMOTING ${city} to regular priority: no changes for ${hoursSinceLastChange.toFixed(1)} hours`);
                    this.removeHighPriorityCity(city);
                    priority.isHighPriority = false;
                    demotedCities.push(city);
                }
            }
        }

        // Log summary
        if (promotedCities.length > 0 || demotedCities.length > 0) {
            logger.info(`Priority evaluation complete: ${promotedCities.length} promoted, ${demotedCities.length} demoted`);
        }
    }

    /**
     * Track forecast change for volatility detection
     */
    private trackForecastChange(city: string): void {
        const normalizedCity = city.toLowerCase();
        let priority = this.cityPriorities.get(normalizedCity);
        if (!priority) {
            priority = {
                city: normalizedCity,
                isHighPriority: this.isHighPriorityCity(city),
                volatilityScore: 0,
                lastForecastChange: null,
                changeHistory: []
            };
        }
        
        const now = new Date();
        priority.changeHistory.push(now);
        priority.lastForecastChange = now;
        
        // Clean up old entries and update volatility score
        this.cleanupOldChangeHistory(normalizedCity);
        
        this.cityPriorities.set(normalizedCity, priority);
    }

    private async updateCityForecasts(city: string, markets: ParsedWeatherMarket[]): Promise<void> {
        try {
            // Check cache validity
            let weatherData: WeatherData;
            const cached = this.cityCache.get(city);

            // 12s cache to balance speed and rate limits
            if (cached && (Date.now() - cached.timestamp.getTime() < this.cacheTtlMs)) {
                weatherData = cached.data;
            } else {
                weatherData = await this.weatherService.getForecastByCity(city);
                this.cityCache.set(city, { data: weatherData, timestamp: new Date() });
            }

            for (const market of markets) {
                if (!market.targetDate) continue;

                let probability = 0;
                let forecastValue = 0;
                let hasValidForecast = false;

                // Extract forecast value based on metric
                if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
                    // Use static helper to avoid extra API call
                    const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                    if (high !== null && market.threshold !== undefined) {
                        forecastValue = high;

                        // Normalize threshold to F for comparison (forecast is always F)
                        let thresholdF = market.threshold;
                        if (market.thresholdUnit === 'C') {
                            thresholdF = (market.threshold * 9 / 5) + 32;
                        }

                        probability = this.weatherService.calculateTempExceedsProbability(high, thresholdF);
                        if (market.comparisonType === 'below') probability = 1 - probability;
                        hasValidForecast = true;
                    }
                } else if (market.metricType === 'temperature_low') {
                    const low = WeatherService.calculateLow(weatherData, market.targetDate);
                    if (low !== null && market.threshold !== undefined) {
                        forecastValue = low;

                        // Normalize threshold to F
                        let thresholdF = market.threshold;
                        if (market.thresholdUnit === 'C') {
                            thresholdF = (market.threshold * 9 / 5) + 32;
                        }

                        probability = this.weatherService.calculateTempExceedsProbability(low, thresholdF);
                        // For low temp, "below" usually means "colder than". 
                        // Probability calculated is "exceeds" (warmer than).
                        // If market is "Low < 30", and forecast is 25. Exceeds(25, 30) -> Low prob.
                        // We want prob of being BELOW. So 1 - Exceeds.
                        if (market.comparisonType === 'below') {
                            probability = 1 - probability;
                        } else {
                            // Market "Low > 30". Forecast 35. Exceeds(35, 30) -> High prob. Correct.
                        }
                        hasValidForecast = true;
                    }
                } else if (market.metricType === 'precipitation') {
                    // Normalize target date for comparison
                    const targetDateObj = new Date(market.targetDate);
                    targetDateObj.setUTCHours(0, 0, 0, 0);

                    const dayForecasts = weatherData.hourly.filter((h: { timestamp: Date }) => {
                        const hourDate = new Date(h.timestamp);
                        hourDate.setUTCHours(0, 0, 0, 0);
                        return hourDate.getTime() === targetDateObj.getTime();
                    });

                    if (dayForecasts.length > 0) {
                        const maxPrecipProb = Math.max(...dayForecasts.map((h: { probabilityOfPrecipitation: number }) => h.probabilityOfPrecipitation));
                        forecastValue = maxPrecipProb;
                        probability = maxPrecipProb / 100; // 0-1
                        if (market.comparisonType === 'below') probability = 1 - probability; // "Will it NOT rain?"
                        hasValidForecast = true;
                    }
                }

                if (!hasValidForecast) continue;

                // SPEED ARBITRAGE: Detect if forecast value actually changed
                const currentState = this.store.getMarketState(market.market.id);
                const previousValue = currentState?.lastForecast?.forecastValue;
                const previousSource = currentState?.lastForecast?.weatherData?.source;
                const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

                // Calculate change amount
                const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

                // Determine significant change threshold based on metric type
                let significantChangeThreshold: number;
                switch (market.metricType) {
                    case 'temperature_high':
                    case 'temperature_low':
                    case 'temperature_threshold':
                    case 'temperature_range':
                        significantChangeThreshold = 1; // 1°F change is significant
                        break;
                    default:
                        significantChangeThreshold = 1;
                }

                // Did the value change significantly?
                // Only consider it a change if source is the same to avoid noise from provider rotation
                const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
                const valueChanged = !sourceChanged && changeAmount >= significantChangeThreshold;

                const now = new Date();

                // Track when the change occurred
                // If changed now, use current time. Otherwise, keep previous change time
                const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

                // Initialize market if new
                const isNew = !this.initializedMarkets.has(market.market.id);
                if (isNew) {
                    this.initializedMarkets.add(market.market.id);
                }

                // Prevent initial value from triggering change
                const realChange = valueChanged && !isNew;

                if (realChange) {
                    // Log only minimal info - forecast values disabled per user request
                    logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`);
                    
                    // Track volatility for priority adjustment
                    this.trackForecastChange(city);

                    if (this.onForecastChanged) {
                        this.onForecastChanged(market.market.id, changeAmount);
                    }
                }

                const snapshot: ForecastSnapshot = {
                    marketId: market.market.id,
                    weatherData,
                    forecastValue,
                    probability,
                    timestamp: now,
                    // Speed arbitrage fields
                    previousValue,
                    valueChanged: realChange,
                    changeAmount,
                    changeTimestamp,
                };

                this.store.updateForecast(market.market.id, snapshot);
            }

        } catch (error) {
            // Error already logged in poll() for parallel execution
            throw error;
        }
    }

    /**
     * Process markets for a city using already-fetched weather data
     * Used by batch fetching to avoid duplicate API calls
     */
    private async processCityMarkets(city: string, markets: ParsedWeatherMarket[], weatherData: WeatherData): Promise<void> {
        for (const market of markets) {
            if (!market.targetDate) continue;

            let probability = 0;
            let forecastValue = 0;
            let hasValidForecast = false;

            // Extract forecast value based on metric
            if (market.metricType === 'temperature_high' || market.metricType === 'temperature_threshold') {
                const high = WeatherService.calculateHigh(weatherData, market.targetDate);
                if (high !== null && market.threshold !== undefined) {
                    forecastValue = high;

                    let thresholdF = market.threshold;
                    if (market.thresholdUnit === 'C') {
                        thresholdF = (market.threshold * 9 / 5) + 32;
                    }

                    probability = this.weatherService.calculateTempExceedsProbability(high, thresholdF);
                    if (market.comparisonType === 'below') probability = 1 - probability;
                    hasValidForecast = true;
                }
            } else if (market.metricType === 'temperature_low') {
                const low = WeatherService.calculateLow(weatherData, market.targetDate);
                if (low !== null && market.threshold !== undefined) {
                    forecastValue = low;

                    let thresholdF = market.threshold;
                    if (market.thresholdUnit === 'C') {
                        thresholdF = (market.threshold * 9 / 5) + 32;
                    }

                    probability = this.weatherService.calculateTempExceedsProbability(low, thresholdF);
                    if (market.comparisonType === 'below') {
                        probability = 1 - probability;
                    }
                    hasValidForecast = true;
                }
            } else if (market.metricType === 'precipitation') {
                const targetDateObj = new Date(market.targetDate);
                targetDateObj.setUTCHours(0, 0, 0, 0);

                const dayForecasts = weatherData.hourly.filter((h: { timestamp: Date }) => {
                    const hourDate = new Date(h.timestamp);
                    hourDate.setUTCHours(0, 0, 0, 0);
                    return hourDate.getTime() === targetDateObj.getTime();
                });

                if (dayForecasts.length > 0) {
                    const maxPrecipProb = Math.max(...dayForecasts.map((h: { probabilityOfPrecipitation: number }) => h.probabilityOfPrecipitation));
                    forecastValue = maxPrecipProb;
                    probability = maxPrecipProb / 100;
                    if (market.comparisonType === 'below') probability = 1 - probability;
                    hasValidForecast = true;
                }
            }

            if (!hasValidForecast) continue;

            const currentState = this.store.getMarketState(market.market.id);
            const previousValue = currentState?.lastForecast?.forecastValue;
            const previousSource = currentState?.lastForecast?.weatherData?.source;
            const previousChangeTimestamp = currentState?.lastForecast?.changeTimestamp;

            const changeAmount = previousValue !== undefined ? Math.abs(forecastValue - previousValue) : 0;

            let significantChangeThreshold: number;
            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_low':
                case 'temperature_threshold':
                case 'temperature_range':
                    significantChangeThreshold = 1;
                    break;
                default:
                    significantChangeThreshold = 1;
            }

            const sourceChanged = previousSource !== undefined && previousSource !== weatherData.source;
            const valueChanged = !sourceChanged && changeAmount >= significantChangeThreshold;

            const now = new Date();
            const changeTimestamp = valueChanged ? now : (previousChangeTimestamp || now);

            const isNew = !this.initializedMarkets.has(market.market.id);
            if (isNew) {
                this.initializedMarkets.add(market.market.id);
            }

            const realChange = valueChanged && !isNew;

            if (realChange) {
                logger.info(`⚡ FORECAST CHANGED for ${city} (${market.metricType})`);
                
                // Track volatility for priority adjustment
                this.trackForecastChange(city);

                if (this.onForecastChanged) {
                    this.onForecastChanged(market.market.id, changeAmount);
                }
            }

            const snapshot: ForecastSnapshot = {
                marketId: market.market.id,
                weatherData,
                forecastValue,
                probability,
                timestamp: now,
                previousValue,
                valueChanged: realChange,
                changeAmount,
                changeTimestamp,
            };

            this.store.updateForecast(market.market.id, snapshot);
        }
    }
}
