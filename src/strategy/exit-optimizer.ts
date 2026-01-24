/**
 * Exit Optimizer
 * Determines when to close positions (Profit Taking / Stop Loss)
 */

import { MarketModel } from '../probability/market-model.js';
import { logger } from '../logger.js';

export interface Position {
    marketId: string;
    side: 'yes' | 'no';
    entryPrice: number;
    currentPrice: number;
    size: number; // Shares
    entryTime: Date;
    pnl: number;        // Unrealized PnL amount
    pnlPercent: number; // Unrealized PnL % (e.g. 0.10 for 10%)
}

export interface ExitSignal {
    shouldExit: boolean;
    reason?: string;
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
    limitPrice?: number;
}

export class ExitOptimizer {
    private marketModel: MarketModel;

    // Configuration
    private takeProfitThreshold: number = 0.20; // 20%
    private stopLossThreshold: number = -0.10;  // -10%
    private timeLimitMs: number = 24 * 60 * 60 * 1000; // 24 hours max hold

    constructor(marketModel: MarketModel) {
        this.marketModel = marketModel;
    }

    /**
     * Check if a position should be exited
     */
    checkExit(position: Position, forecastProbability: number): ExitSignal {
        // 1. Stop Loss
        if (position.pnlPercent <= this.stopLossThreshold) {
            return {
                shouldExit: true,
                reason: `Stop Loss hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        // 2. Take Profit (Target Price)
        // If price reached fair value (forecast probability), take profit?
        // Or if we hit fixed ROI threshold.
        const fairValue = forecastProbability;
        const currentPrice = position.currentPrice;

        // If we are LONG YES, and Price >= FairValue, maybe exit?
        // Or if we surpassed fair value (Market Overreaction).

        const isOvervalued = position.side === 'yes'
            ? currentPrice >= fairValue
            : currentPrice <= fairValue;

        if (isOvervalued) {
            return {
                shouldExit: true,
                reason: `Fair value reached (Price ${currentPrice.toFixed(2)} vs Prob ${fairValue.toFixed(2)})`,
                urgency: 'MEDIUM'
            };
        }

        if (position.pnlPercent >= this.takeProfitThreshold) {
            return {
                shouldExit: true,
                reason: `Take Profit hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        // 3. Time Limit
        const holdTime = Date.now() - position.entryTime.getTime();
        if (holdTime > this.timeLimitMs) {
            return {
                shouldExit: true,
                reason: `Time limit exceeded (${(holdTime / 3600000).toFixed(1)}h)`,
                urgency: 'LOW'
            };
        }

        // 4. Forecast Reversal (Stop Loss based on fundamental change)
        // If forecast changed against us significantly.
        // Assuming forecastProbability is the NEW probability.
        // If we are LONG YES (entry 0.50), and Forecast is now 0.30.
        // That is captured by "Fair value reached" logic? 
        // No, Fair Value Reached logic above:
        // YES: Price (0.50) >= FairValue (0.30) -> TRUE, Exit.
        // So yes, it covers bad news too.

        return { shouldExit: false };
    }
}
