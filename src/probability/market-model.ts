/**
 * Market Model
 * Models market behavior, liquidity, and reaction times
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { DataStore } from '../realtime/data-store.js';

export class MarketModel {
    private store: DataStore;

    constructor(store: DataStore) {
        this.store = store;
    }

    /**
     * Estimate market liquidity score (0-1)
     * Higher is better (more liquid)
     */
    getLiquidityScore(marketId: string): number {
        // Ideally we'd look at orderbook depth.
        // Proxy: Look at spread or volume if available.
        // For now, heuristic based on activity
        const state = this.store.getMarketState(marketId);
        if (!state) return 0.5;

        // Use price updates frequency as proxy for activity?
        // Or just spread if we had it.
        // Placeholder: Return constant for now, upgraded when OB data available
        return 0.7;
    }

    /**
     * Estimate expected slippage for a trade size
     */
    estimateSlippage(marketId: string, tradeSizeUsdc: number): number {
        const liquidity = this.getLiquidityScore(marketId);

        // Model: Liquidity L, Trade T. Slippage ~ T / L
        // Calibrated: $1000 trade on avg market (0.7) -> 1% slippage?
        // 0.01 = 1000 * k / 0.7 => k = 0.000007

        const k = 0.00001;
        const slippage = (tradeSizeUsdc * k) / liquidity;

        return Math.min(slippage, 0.10); // Cap at 10%
    }

    /**
     * Calculate current price velocity (change per second)
     */
    getPriceVelocity(marketId: string, outcome: 'yes' | 'no'): number {
        const state = this.store.getMarketState(marketId);
        if (!state) return 0;

        const history = outcome === 'yes' ? state.priceHistory.yes : state.priceHistory.no;
        return history.velocity;
    }

    /**
     * Detect if market is "lagging" behind news
     * Returns estimated lag in seconds
     */
    estimateReactionLag(marketId: string): number {
        // In a mature system, we'd measure time between "Forecast Change" and "Price Change".
        // For cold start, we assume 60 seconds.
        return 60;
    }
}
