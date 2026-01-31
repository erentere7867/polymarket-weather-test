/**
 * Real-Time Data Store
 * In-memory database for market state, price history, and forecasts
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { MarketState, PricePoint, ForecastSnapshot } from './types.js';
import { logger } from '../logger.js';

export class DataStore {
    private markets: Map<string, MarketState> = new Map();
    private tokenToMarketId: Map<string, string> = new Map();

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
}
