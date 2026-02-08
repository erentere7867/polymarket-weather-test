/**
 * Exit Optimizer
 * Determines when to close positions (Profit Taking / Stop Loss)
 * Enhanced with price momentum detection and resolution-time exit
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
    priceHistory?: { price: number; timestamp: Date }[]; // For momentum detection
    marketEndTime?: Date; // When market resolves
    isGuaranteed?: boolean; // If true, hold to settlement (ignore TP/Fair Value)
}

export interface ExitSignal {
    shouldExit: boolean;
    reason?: string;
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
    limitPrice?: number;
}

// Exit before resolution deadline to avoid settlement risk
const EXIT_BEFORE_RESOLUTION_MS = 2 * 60 * 60 * 1000; // 2 hours before

export class ExitOptimizer {
    private marketModel: MarketModel;

    // Configuration
    private takeProfitThreshold: number = 0.05; // 5% - aggressive micro-profits
    private stopLossThreshold: number = -0.30;  // -30% (relaxed to handle spread)
    private timeLimitMs: number = 24 * 60 * 60 * 1000; // 24 hours max hold
    private momentumWindowMs: number = 60 * 1000; // 1 minute window for momentum

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
     * Calculate price momentum (positive = price rising, negative = falling)
     * Returns price change per second
     */
    private calculateMomentum(priceHistory: { price: number; timestamp: Date }[] | undefined): number {
        if (!priceHistory || priceHistory.length < 2) return 0;

        const now = Date.now();
        const recentPrices = priceHistory.filter(p =>
            now - p.timestamp.getTime() < this.momentumWindowMs
        );

        if (recentPrices.length < 2) return 0;

        const first = recentPrices[0];
        const last = recentPrices[recentPrices.length - 1];
        const timeDeltaS = (last.timestamp.getTime() - first.timestamp.getTime()) / 1000;

        if (timeDeltaS <= 0) return 0;

        return (last.price - first.price) / timeDeltaS;
    }

    /**
     * Check if momentum is favorable for position
     * YES position: positive momentum = good
     * NO position: negative momentum = good
     */
    private isMomentumFavorable(position: Position): boolean {
        const momentum = this.calculateMomentum(position.priceHistory);

        // Only consider significant momentum (> 0.001/sec = 6% per minute)
        const significantMomentum = Math.abs(momentum) > 0.001;
        if (!significantMomentum) return false;

        if (position.side === 'yes') {
            return momentum > 0; // Price rising is good for YES
        } else {
            return momentum < 0; // Price falling is good for NO (our NO shares gain value)
        }
    }

    /**
     * Check if position should be exited
     */
    checkExit(position: Position, forecastProbability: number): ExitSignal {
        // 0. Emergency: Exit before market resolution
        if (position.marketEndTime) {
            const timeToResolution = position.marketEndTime.getTime() - Date.now();
            if (timeToResolution < EXIT_BEFORE_RESOLUTION_MS && timeToResolution > 0) {
                return {
                    shouldExit: true,
                    reason: `Market resolves in ${(timeToResolution / 3600000).toFixed(1)}h - exiting to avoid settlement risk`,
                    urgency: 'HIGH'
                };
            }
        }

        // 1. Stop Loss (always exit on stop loss)
        if (position.pnlPercent <= this.stopLossThreshold) {
            // For guaranteed trades, we might even ignore stop loss if we are VERY confident,
            // but for safety we keep it broadly looser or standard. 
            // In this strategy, "a few losses don't matter", so we accept the Stop Loss.
            return {
                shouldExit: true,
                reason: `Stop Loss hit: ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        // SPECIAL CASE: Guaranteed Outcome - Hold to Settlement
        // We only exit if the forecast changes significantly (logic handled externally) 
        // or if we are forced to via emergency exit.
        if (position.isGuaranteed) {
            logger.debug(`🔒 Holding guaranteed position ${position.marketId} to settlement`);
            return { shouldExit: false };
        }

        // 2. Take Profit with momentum check
        const fairValue = forecastProbability;
        const currentPrice = position.currentPrice;

        // If we hit take profit threshold BUT momentum is still favorable, hold
        if (position.pnlPercent >= this.takeProfitThreshold) {
            const favorableMomentum = this.isMomentumFavorable(position);

            if (favorableMomentum) {
                // Don't exit yet - price still moving in our favor
                logger.debug(`💨 Holding despite TP hit - favorable momentum for ${position.marketId}`);
            } else {
                return {
                    shouldExit: true,
                    reason: `Take Profit hit: ${(position.pnlPercent * 100).toFixed(1)}% (momentum slowed)`,
                    urgency: 'MEDIUM'
                };
            }
        }

        // 3. Fair value reached (market caught up)
        const isOvervalued = position.side === 'yes'
            ? currentPrice >= fairValue
            : currentPrice <= fairValue;

        if (isOvervalued) {
            // Even if overvalued, check if momentum suggests further movement
            const favorableMomentum = this.isMomentumFavorable(position);

            if (favorableMomentum && position.pnlPercent > 0) {
                // Hold if momentum still favorable and we're in profit
                logger.debug(`💨 Holding despite fair value - favorable momentum for ${position.marketId}`);
            } else {
                return {
                    shouldExit: true,
                    reason: `Fair value reached (Price ${currentPrice.toFixed(2)} vs Prob ${fairValue.toFixed(2)})`,
                    urgency: 'MEDIUM'
                };
            }
        }

        // 4. Time Limit
        const holdTime = Date.now() - position.entryTime.getTime();
        if (holdTime > this.timeLimitMs) {
            return {
                shouldExit: true,
                reason: `Time limit exceeded (${(holdTime / 3600000).toFixed(1)}h)`,
                urgency: 'LOW'
            };
        }

        return { shouldExit: false };
    }
}
