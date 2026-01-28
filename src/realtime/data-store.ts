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

    // Debug Stats
    private lastGlobalPriceUpdate: Date | null = null;
    private lastGlobalForecastUpdate: Date | null = null;
    private totalPriceUpdates: number = 0;
    private totalForecastUpdates: number = 0;

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

        const isYes = state.market.yesTokenId === tokenId;
        const historyObj = isYes ? state.priceHistory.yes : state.priceHistory.no;

        // Update market object directly to ensure consumers see latest price
        if (isYes) {
            state.market.yesPrice = price;
        } else {
            state.market.noPrice = price;
        }

        // Add new point
        historyObj.history.push({ price, timestamp });
        historyObj.lastUpdated = timestamp;

        // Update Global Stats
        this.lastGlobalPriceUpdate = timestamp;
        this.totalPriceUpdates++;

        // Prune history older than 60 minutes
        const cutoff = new Date(timestamp.getTime() - 60 * 60 * 1000);
        // Optimization: Only run filter if the oldest point is actually expired
        // This prevents O(N) memory allocation on every update
        if (historyObj.history.length > 0 && historyObj.history[0].timestamp <= cutoff) {
            historyObj.history = historyObj.history.filter(p => p.timestamp > cutoff);
        }

        // Calculate velocity (price change per second over last minute)
        this.updateVelocity(historyObj);
    }

    private updateVelocity(history: { history: PricePoint[], velocity: number }): void {
        const now = new Date();
        const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
        const hist = history.history;

        // OPTIMIZATION: Replaced .filter() (O(N) allocation) with index search
        // Find the start index of points within the 1-minute window
        let validStartIndex = 0;
        let found = false;
        const limit = oneMinuteAgo.getTime();

        // Search backwards because the window (1m) is much smaller than history (60m)
        for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i].timestamp.getTime() <= limit) {
                // This point is too old. The NEXT point (i+1) is the first valid one.
                validStartIndex = i + 1;
                found = true;
                break;
            }
        }

        // If loop finished without finding an old point, all points are valid (index 0)
        if (!found) {
            validStartIndex = 0;
        }

        // Need at least 2 points to calculate velocity
        // validStartIndex is the first valid index.
        // If validStartIndex >= hist.length - 1, we have 0 or 1 valid point.
        if (validStartIndex >= hist.length - 1) {
            history.velocity = 0;
            return;
        }

        const first = hist[validStartIndex];
        const last = hist[hist.length - 1];
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

        // Update Global Stats
        this.lastGlobalForecastUpdate = snapshot.timestamp;
        this.totalForecastUpdates++;

        // Keep last 24h of forecasts
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        state.forecastHistory = state.forecastHistory.filter(f => f.timestamp > cutoff);
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

    /**
     * Get Debug Stats
     */
    getStats() {
        return {
            marketCount: this.markets.size,
            lastPriceUpdate: this.lastGlobalPriceUpdate,
            lastForecastUpdate: this.lastGlobalForecastUpdate,
            totalPriceUpdates: this.totalPriceUpdates,
            totalForecastUpdates: this.totalForecastUpdates
        };
    }
}
