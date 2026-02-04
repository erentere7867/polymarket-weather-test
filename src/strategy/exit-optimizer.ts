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
    private takeProfitThreshold: number = 0.10; // 10% - let winners run longer
    private stopLossThreshold: number = -0.15;  // -15% - give trades more room
    private timeLimitMs: number = 24 * 60 * 60 * 1000; // 24 hours max hold
    
    // Trailing stop configuration
    private trailingStopEnabled: boolean = true;
    private trailingStopActivationPercent: number = 0.05; // Activate at 5% profit
    private trailingStopOffsetPercent: number = 0.02; // Stop at breakeven + 2%
    
    // Track highest PnL seen for each position (for trailing stop)
    private positionHighWaterMark: Map<string, number> = new Map();

    constructor(marketModel: MarketModel) {
        this.marketModel = marketModel;
    }

    /**
     * Update configuration thresholds
     */
    updateConfig(takeProfit: number, stopLoss: number): void {
        this.takeProfitThreshold = takeProfit;
        this.stopLossThreshold = stopLoss;
        logger.info(`ExitOptimizer config updated: TP=${(takeProfit * 100).toFixed(1)}%, SL=${(stopLoss * 100).toFixed(1)}%`);
    }

    /**
     * Get current configuration
     */
    getConfig(): { takeProfit: number; stopLoss: number } {
        return {
            takeProfit: this.takeProfitThreshold,
            stopLoss: this.stopLossThreshold
        };
    }

    /**
     * Update high water mark for trailing stop
     */
    private updateHighWaterMark(position: Position): void {
        const currentHigh = this.positionHighWaterMark.get(position.marketId) || 0;
        if (position.pnlPercent > currentHigh) {
            this.positionHighWaterMark.set(position.marketId, position.pnlPercent);
        }
    }
    
    /**
     * Check if trailing stop should be triggered
     */
    private checkTrailingStop(position: Position): ExitSignal | null {
        if (!this.trailingStopEnabled) return null;
        
        // Update high water mark
        this.updateHighWaterMark(position);
        const highWaterMark = this.positionHighWaterMark.get(position.marketId) || 0;
        
        // Check if trailing stop is activated (position is up more than activation threshold)
        if (highWaterMark >= this.trailingStopActivationPercent) {
            // Calculate trailing stop level: breakeven + offset
            const trailingStopLevel = this.trailingStopOffsetPercent;
            
            // If current PnL drops below trailing stop level, exit
            if (position.pnlPercent <= trailingStopLevel) {
                // Clean up high water mark
                this.positionHighWaterMark.delete(position.marketId);
                return {
                    shouldExit: true,
                    reason: `Trailing Stop triggered: PnL ${(position.pnlPercent * 100).toFixed(1)}% dropped from high ${(highWaterMark * 100).toFixed(1)}%`,
                    urgency: 'HIGH'
                };
            }
        }
        
        return null;
    }
    
    /**
     * Clear high water mark for a position (e.g., when position is closed)
     */
    clearPosition(marketId: string): void {
        this.positionHighWaterMark.delete(marketId);
    }

    /**
     * Check if a position should be exited
     */
    checkExit(position: Position, forecastProbability: number): ExitSignal {
        // 0. Trailing Stop Check (highest priority after stop loss)
        const trailingStopSignal = this.checkTrailingStop(position);
        if (trailingStopSignal) {
            return trailingStopSignal;
        }
        
        // 1. Stop Loss
        if (position.pnlPercent <= this.stopLossThreshold) {
            // Clean up high water mark on stop loss
            this.positionHighWaterMark.delete(position.marketId);
            return {
                shouldExit: true,
                reason: `Stop Loss hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        // 2. Take Profit (Target Price)
        // Only exit at fair value if we have meaningful profit (avoid 0% PnL exits)
        const fairValue = forecastProbability;
        const currentPrice = position.currentPrice;

        // Fair value exit only makes sense if:
        // 1. We have a meaningful profit (>1%), OR
        // 2. The price moved significantly toward fair value since entry
        // This prevents immediate exits when entry price was already at fair value
        const priceMovedSignificantly = Math.abs(currentPrice - position.entryPrice) > 0.01; // >1 cent move
        const hasMeaningfulProfit = position.pnlPercent > 0.01; // >1% profit

        const isOvervalued = position.side === 'yes'
            ? currentPrice >= fairValue
            : currentPrice <= fairValue;

        // Only exit on fair value if we actually made money (not 0% PnL)
        if (isOvervalued && hasMeaningfulProfit) {
            // Clean up high water mark on fair value exit
            this.positionHighWaterMark.delete(position.marketId);
            return {
                shouldExit: true,
                reason: `Fair value reached with profit (Price ${currentPrice.toFixed(2)} vs Prob ${fairValue.toFixed(2)}, PnL: ${(position.pnlPercent * 100).toFixed(1)}%)`,
                urgency: 'MEDIUM'
            };
        }

        if (position.pnlPercent >= this.takeProfitThreshold) {
            // Clean up high water mark on take profit
            this.positionHighWaterMark.delete(position.marketId);
            return {
                shouldExit: true,
                reason: `Take Profit hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        // 3. Take Profit
        if (position.pnlPercent >= this.takeProfitThreshold) {
            // Clean up high water mark on take profit
            this.positionHighWaterMark.delete(position.marketId);
            return {
                shouldExit: true,
                reason: `Take Profit hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        // 4. Time Limit
        const holdTimeMs = Date.now() - position.entryTime.getTime();
        if (holdTimeMs > this.timeLimitMs) {
            // Clean up high water mark on time limit exit
            this.positionHighWaterMark.delete(position.marketId);
            return {
                shouldExit: true,
                reason: `Time limit exceeded (${(holdTimeMs / 3600000).toFixed(1)}h)`,
                urgency: 'LOW'
            };
        }

        // 5. Forecast Reversal (Stop Loss based on fundamental change)
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
