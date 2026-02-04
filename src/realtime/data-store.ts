/**
 * Real-Time Data Store
 * In-memory database for market state, price history, and forecasts
 * Extended to support file-confirmed forecast data
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { MarketState, PricePoint, ForecastSnapshot } from './types.js';
import { ModelType, CityGRIBData } from '../weather/types.js';
import { logger } from '../logger.js';

/**
 * Confirmation status for forecast data
 */
export type ForecastConfirmationStatus = 'UNCONFIRMED' | 'FILE_CONFIRMED';

/**
 * Extended forecast snapshot with confirmation status
 */
export interface ConfirmedForecastSnapshot extends ForecastSnapshot {
    confirmationStatus: ForecastConfirmationStatus;
    confirmedAt?: Date;
    source: 'API' | 'FILE';
    model?: ModelType;
    cycleHour?: number;
    forecastHour?: number;
}

/**
 * Cached previous run value for change detection
 */
export interface CachedRunValue {
    cityId: string;
    variable: 'temperature' | 'windSpeed' | 'precipitation';
    value: number;
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    timestamp: Date;
    source: 'API' | 'FILE';
}

export class DataStore {
    private markets: Map<string, MarketState> = new Map();
    private tokenToMarketId: Map<string, string> = new Map();
    
    // File-confirmed forecast storage
    private fileConfirmedForecasts: Map<string, ConfirmedForecastSnapshot> = new Map(); // marketId -> forecast
    private confirmationStatus: Map<string, ForecastConfirmationStatus> = new Map(); // marketId -> status
    
    // Previous run cache for change detection
    private previousRunCache: Map<string, CachedRunValue> = new Map(); // composite key -> value

    constructor() { }

    /**
     * Register a market for tracking
     */
    addMarket(market: ParsedWeatherMarket): void {
        if (this.markets.has(market.market.id)) {
            return;
        }

        const state: MarketState = {
            market,
            priceHistory: {
                yes: {
                    tokenId: market.yesTokenId,
                    history: [],
                    lastUpdated: new Date(),
                    velocity: 0
                },
                no: {
                    tokenId: market.noTokenId,
                    history: [],
                    lastUpdated: new Date(),
                    velocity: 0
                }
            },
            forecastHistory: []
        };

        this.markets.set(market.market.id, state);
        this.tokenToMarketId.set(market.yesTokenId, market.market.id);
        this.tokenToMarketId.set(market.noTokenId, market.market.id);
    }

    /**
     * Update price for a token
     */
    updatePrice(tokenId: string, price: number, timestamp: Date = new Date()): void {
        const marketId = this.tokenToMarketId.get(tokenId);
        if (!marketId) return;

        const state = this.markets.get(marketId);
        if (!state) return;

        const historyObj = state.market.yesTokenId === tokenId ? state.priceHistory.yes : state.priceHistory.no;

        // Update current price in market object
        if (state.market.yesTokenId === tokenId) {
            state.market.yesPrice = price;
        } else {
            state.market.noPrice = price;
        }

        // Add new point
        historyObj.history.push({ price, timestamp });
        historyObj.lastUpdated = timestamp;

        // Prune history older than 10 minutes (reduced from 60 for performance)
        // We only need recent history for velocity calculation
        const cutoffTime = timestamp.getTime() - 10 * 60 * 1000;
        // Use binary search to find the cutoff index for O(log n) pruning
        const history = historyObj.history;
        let left = 0;
        let right = history.length;
        while (left < right) {
            const mid = (left + right) >>> 1;
            if (history[mid].timestamp.getTime() < cutoffTime) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        // Remove all elements before the found index
        if (left > 0) {
            history.splice(0, left);
        }

        // Calculate velocity only every 5 updates to reduce CPU usage
        if (historyObj.history.length % 5 === 0) {
            this.updateVelocity(historyObj);
        }
    }

    private updateVelocity(history: { history: PricePoint[], velocity: number }): void {
        const now = new Date();
        const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

        const recentPoints = history.history.filter(p => p.timestamp > oneMinuteAgo);
        if (recentPoints.length < 2) {
            history.velocity = 0;
            return;
        }

        const first = recentPoints[0];
        const last = recentPoints[recentPoints.length - 1];
        const timeDiffSeconds = (last.timestamp.getTime() - first.timestamp.getTime()) / 1000;

        if (timeDiffSeconds > 0) {
            history.velocity = (last.price - first.price) / timeDiffSeconds;
        } else {
            history.velocity = 0;
        }
    }

    /**
     * Update forecast for a market
     */
    updateForecast(marketId: string, snapshot: ForecastSnapshot): void {
        const state = this.markets.get(marketId);
        if (!state) return;

        state.lastForecast = snapshot;
        state.forecastHistory.push(snapshot);

        // Keep last 24h of forecasts using binary search for efficient pruning
        const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
        const forecasts = state.forecastHistory;
        let left = 0;
        let right = forecasts.length;
        while (left < right) {
            const mid = (left + right) >>> 1;
            if (forecasts[mid].timestamp.getTime() < cutoffTime) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        if (left > 0) {
            forecasts.splice(0, left);
        }
    }

    /**
     * Get state for a market
     */
    getMarketState(marketId: string): MarketState | undefined {
        return this.markets.get(marketId);
    }

    /**
     * Get all tracked markets
     */
    getAllMarkets(): ParsedWeatherMarket[] {
        return Array.from(this.markets.values()).map(s => s.market);
    }

    /**
     * Get market ID by token ID
     */
    getMarketIdByToken(tokenId: string): string | undefined {
        return this.tokenToMarketId.get(tokenId);
    }

    // ====================
    // File-Confirmed Forecast Methods
    // ====================

    /**
     * Store file-confirmed forecast data
     */
    storeFileConfirmedForecast(
        marketId: string,
        snapshot: ConfirmedForecastSnapshot
    ): void {
        this.fileConfirmedForecasts.set(marketId, snapshot);
        this.confirmationStatus.set(marketId, 'FILE_CONFIRMED');
        
        logger.debug(`[DataStore] File-confirmed forecast stored for ${marketId}`);
    }

    /**
     * Store unconfirmed (API) forecast data
     */
    storeUnconfirmedForecast(
        marketId: string,
        snapshot: ForecastSnapshot
    ): void {
        const confirmedSnapshot: ConfirmedForecastSnapshot = {
            ...snapshot,
            confirmationStatus: 'UNCONFIRMED',
            source: 'API',
        };
        
        // Only store if no file-confirmed data exists (file data takes priority)
        if (!this.fileConfirmedForecasts.has(marketId)) {
            this.fileConfirmedForecasts.set(marketId, confirmedSnapshot);
            this.confirmationStatus.set(marketId, 'UNCONFIRMED');
        }
    }

    /**
     * Get forecast with confirmation status
     */
    getConfirmedForecast(marketId: string): ConfirmedForecastSnapshot | undefined {
        return this.fileConfirmedForecasts.get(marketId);
    }

    /**
     * Get confirmation status for a market
     */
    getConfirmationStatus(marketId: string): ForecastConfirmationStatus | undefined {
        return this.confirmationStatus.get(marketId);
    }

    /**
     * Check if market has file-confirmed data
     */
    isFileConfirmed(marketId: string): boolean {
        return this.confirmationStatus.get(marketId) === 'FILE_CONFIRMED';
    }

    /**
     * Reconcile API data with file-confirmed data
     * Returns true if reconciliation was performed
     */
    reconcileForecast(
        marketId: string,
        fileData: CityGRIBData,
        model: ModelType,
        cycleHour: number,
        forecastHour: number
    ): boolean {
        const existing = this.fileConfirmedForecasts.get(marketId);
        if (!existing) return false;

        // Update with file data
        const reconciled: ConfirmedForecastSnapshot = {
            ...existing,
            confirmationStatus: 'FILE_CONFIRMED',
            confirmedAt: new Date(),
            source: 'FILE',
            model,
            cycleHour,
            forecastHour,
        };

        this.fileConfirmedForecasts.set(marketId, reconciled);
        this.confirmationStatus.set(marketId, 'FILE_CONFIRMED');

        logger.debug(`[DataStore] Forecast reconciled for ${marketId} with ${model} ${cycleHour}Z`);
        return true;
    }

    // ====================
    // Previous Run Cache Methods
    // ====================

    /**
     * Cache a previous run value for change detection
     */
    cachePreviousRunValue(
        cityId: string,
        variable: 'temperature' | 'windSpeed' | 'precipitation',
        value: number,
        model: ModelType,
        cycleHour: number,
        forecastHour: number,
        source: 'API' | 'FILE'
    ): void {
        const key = this.getCacheKey(cityId, variable, forecastHour);
        const cached: CachedRunValue = {
            cityId,
            variable,
            value,
            model,
            cycleHour,
            forecastHour,
            timestamp: new Date(),
            source,
        };
        this.previousRunCache.set(key, cached);
    }

    /**
     * Get cached previous run value
     */
    getPreviousRunValue(
        cityId: string,
        variable: 'temperature' | 'windSpeed' | 'precipitation',
        forecastHour: number
    ): CachedRunValue | undefined {
        const key = this.getCacheKey(cityId, variable, forecastHour);
        return this.previousRunCache.get(key);
    }

    /**
     * Get all cached values for a city
     */
    getCityCachedValues(cityId: string): CachedRunValue[] {
        const values: CachedRunValue[] = [];
        for (const [key, value] of this.previousRunCache.entries()) {
            if (key.startsWith(`${cityId}:`)) {
                values.push(value);
            }
        }
        return values;
    }

    /**
     * Clear previous run cache for a city
     */
    clearCityCache(cityId: string): void {
        for (const key of this.previousRunCache.keys()) {
            if (key.startsWith(`${cityId}:`)) {
                this.previousRunCache.delete(key);
            }
        }
    }

    /**
     * Clear all previous run cache
     */
    clearAllPreviousRunCache(): void {
        this.previousRunCache.clear();
        logger.info('[DataStore] Previous run cache cleared');
    }

    /**
     * Get cache statistics
     */
    getCacheStats(): {
        fileConfirmedForecasts: number;
        unconfirmedForecasts: number;
        previousRunCacheSize: number;
    } {
        let unconfirmed = 0;
        for (const snapshot of this.fileConfirmedForecasts.values()) {
            if (snapshot.confirmationStatus === 'UNCONFIRMED') {
                unconfirmed++;
            }
        }

        return {
            fileConfirmedForecasts: this.fileConfirmedForecasts.size - unconfirmed,
            unconfirmedForecasts: unconfirmed,
            previousRunCacheSize: this.previousRunCache.size,
        };
    }

    /**
     * Clean up old cache entries
     */
    cleanupOldCache(maxAgeHours: number = 24): void {
        const now = new Date();
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Clean up previous run cache
        for (const [key, value] of this.previousRunCache.entries()) {
            if (now.getTime() - value.timestamp.getTime() > maxAgeMs) {
                this.previousRunCache.delete(key);
            }
        }

        logger.debug('[DataStore] Old cache entries cleaned up');
    }

    /**
     * Generate cache key
     */
    private getCacheKey(
        cityId: string,
        variable: string,
        forecastHour: number
    ): string {
        return `${cityId}:${variable}:${forecastHour}`;
    }
}
