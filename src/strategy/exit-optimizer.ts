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
    
    // New: Partial exit support
    isPartialExit?: boolean;
    percentToExit?: number;  // e.g., 0.5 for 50%
    remainingPosition?: PartialExitPosition;
}

export interface PartialExitPosition {
    entryPrice: number;
    remainingShares: number;
    adjustedStopLoss?: number;
    adjustedTakeProfit?: number;
}

export type VolatilityRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'UNKNOWN';

export interface RegimeThresholds {
    takeProfit: number;
    stopLoss: number;
    trailingStop: boolean;
    partialExit: boolean;
}

export interface PartialExitStatus {
    exitedPercent: number;
    exitPrice?: number;
}

export class ExitOptimizer {
    private marketModel: MarketModel;

    // Configuration - Regime-based thresholds
    // FIXED: Minimum 2:1 Risk/Reward ratio in ALL regimes
    private takeProfitThreshold: number = 0.16; // 16% base
    private stopLossThreshold: number = -0.08;  // -8% base (2:1 R:R)
    private timeLimitMs: number = 12 * 60 * 60 * 1000; // 12 hours max hold (reduced from 24)
    
    // Regime-specific thresholds - ALL with minimum 2:1 R:R
    private regimeConfig: Record<VolatilityRegime, RegimeThresholds> = {
        TRENDING_UP: { takeProfit: 0.20, stopLoss: -0.10, trailingStop: true, partialExit: true },    // 2:1
        TRENDING_DOWN: { takeProfit: 0.12, stopLoss: -0.06, trailingStop: false, partialExit: true }, // 2:1
        RANGING: { takeProfit: 0.16, stopLoss: -0.08, trailingStop: false, partialExit: true },       // 2:1
        VOLATILE: { takeProfit: 0.24, stopLoss: -0.12, trailingStop: true, partialExit: true },      // 2:1
        UNKNOWN: { takeProfit: 0.16, stopLoss: -0.08, trailingStop: true, partialExit: true }        // 2:1
    };
    
    // Trailing stop configuration - FIXED: looser to let winners run
    private trailingStopEnabled: boolean = true;
    private trailingStopActivationPercent: number = 0.10; // Activate at 10% profit (was 5%)
    private trailingStopOffsetPercent: number = 0.05; // Trail 5% behind (was breakeven+2%)
    
    // Track highest PnL seen for each position (for trailing stop)
    private positionHighWaterMark: Map<string, number> = new Map();
    
    // Track partial exits for each position
    private partialExitStatus: Map<string, PartialExitStatus> = new Map();
    
    // Track volatility regime for each position
    private positionRegime: Map<string, VolatilityRegime> = new Map();

    constructor(marketModel: MarketModel) {
        this.marketModel = marketModel;
    }

    /**
     * Set volatility regime for a position
     */
    setPositionRegime(positionId: string, regime: VolatilityRegime): void {
        this.positionRegime.set(positionId, regime);
    }
    
    /**
     * Get current volatility regime for a position
     */
    private getPositionRegime(positionId: string): VolatilityRegime {
        return this.positionRegime.get(positionId) || 'UNKNOWN';
    }
    
    /**
     * Get thresholds for current regime
     */
    private getRegimeThresholds(positionId: string): RegimeThresholds {
        const regime = this.getPositionRegime(positionId);
        return this.regimeConfig[regime];
    }
    
    /**
     * Update partial exit status for a position
     */
    markPartialExit(positionId: string, percentExited: number): void {
        const current = this.partialExitStatus.get(positionId) || { exitedPercent: 0 };
        current.exitedPercent += percentExited;
        this.partialExitStatus.set(positionId, current);
    }
    
    /**
     * Check if position has already partially exited
     */
    private hasPartiallyExited(positionId: string): boolean {
        const status = this.partialExitStatus.get(positionId);
        return (status?.exitedPercent || 0) > 0;
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
     * Update regime-specific thresholds
     */
    updateRegimeConfig(
        regime: VolatilityRegime,
        thresholds: Partial<RegimeThresholds>
    ): void {
        this.regimeConfig[regime] = { ...this.regimeConfig[regime], ...thresholds };
        logger.info(`[ExitOptimizer] Updated ${regime} regime: TP=${(this.regimeConfig[regime].takeProfit * 100).toFixed(0)}%, SL=${(this.regimeConfig[regime].stopLoss * 100).toFixed(0)}%`);
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
     * Enhanced with regime-based thresholds and partial exit support
     */
    checkExit(position: Position, forecastProbability: number): ExitSignal {
        const thresholds = this.getRegimeThresholds(position.marketId);
        
        // 0. Trailing Stop Check (highest priority after stop loss)
        if (thresholds.trailingStop) {
            const trailingStopSignal = this.checkTrailingStop(position);
            if (trailingStopSignal) {
                return trailingStopSignal;
            }
        }
        
        // 1. Check for partial exit opportunity (before full exit checks)
        if (thresholds.partialExit && !this.hasPartiallyExited(position.marketId)) {
            const partialExitSignal = this.checkPartialExit(position, thresholds);
            if (partialExitSignal) {
                return partialExitSignal;
            }
        }
        
        // 2. Stop Loss (regime-adjusted)
        const adjustedStopLoss = this.hasPartiallyExited(position.marketId) 
            ? thresholds.stopLoss * 0.8  // Tighter stop after partial exit
            : thresholds.stopLoss;
            
        if (position.pnlPercent <= adjustedStopLoss) {
            // Clean up tracking on stop loss
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Stop Loss hit (${this.getPositionRegime(position.marketId)}): ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        // 3. Fair Value Exit
        const fairValue = forecastProbability;
        const currentPrice = position.currentPrice;
        const hasMeaningfulProfit = position.pnlPercent > 0.01; // >1% profit

        const isOvervalued = position.side === 'yes'
            ? currentPrice >= fairValue
            : currentPrice <= fairValue;

        if (isOvervalued && hasMeaningfulProfit) {
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Fair value reached (${this.getPositionRegime(position.marketId)}): ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        // 4. Take Profit (regime-adjusted)
        const adjustedTakeProfit = this.hasPartiallyExited(position.marketId)
            ? thresholds.takeProfit * 1.2  // Higher target after taking some profit
            : thresholds.takeProfit;
            
        if (position.pnlPercent >= adjustedTakeProfit) {
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Take Profit hit (${this.getPositionRegime(position.marketId)}): ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        // 5. Time Limit
        const holdTimeMs = Date.now() - position.entryTime.getTime();
        if (holdTimeMs > this.timeLimitMs) {
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Time limit exceeded (${(holdTimeMs / 3600000).toFixed(1)}h)`,
                urgency: 'LOW'
            };
        }

        return { shouldExit: false };
    }

    /**
     * Check if partial exit should be triggered (WINNERS and LOSERS)
     */
    private checkPartialExit(position: Position, thresholds: RegimeThresholds): ExitSignal | null {
        // PARTIAL EXIT FOR WINNERS: At 50% of take profit target
        const partialWinThreshold = thresholds.takeProfit * 0.5;
        
        if (position.pnlPercent >= partialWinThreshold && position.pnlPercent < thresholds.takeProfit) {
            this.markPartialExit(position.marketId, 0.5);
            
            return {
                shouldExit: true,
                isPartialExit: true,
                percentToExit: 0.5,  // Exit 50% of position
                reason: `Partial WIN exit (50%) at ${(position.pnlPercent * 100).toFixed(1)}% profit (${this.getPositionRegime(position.marketId)})`,
                urgency: 'MEDIUM',
                remainingPosition: {
                    entryPrice: position.entryPrice,
                    remainingShares: position.size * 0.5,
                    adjustedStopLoss: position.entryPrice * 1.03,  // Move stop to breakeven + 3% (was 2%)
                    adjustedTakeProfit: position.entryPrice * (1 + thresholds.takeProfit * 1.2)
                }
            };
        }
        
        // PARTIAL EXIT FOR LOSERS: At 50% of stop loss (-4% for -8% SL)
        const partialLossThreshold = thresholds.stopLoss * 0.5; // e.g., -4% if SL is -8%
        
        if (position.pnlPercent <= partialLossThreshold && position.pnlPercent > thresholds.stopLoss) {
            this.markPartialExit(position.marketId, 0.5);
            
            return {
                shouldExit: true,
                isPartialExit: true,
                percentToExit: 0.5,  // Exit 50% of position to cut loss
                reason: `Partial LOSS exit (50%) at ${(position.pnlPercent * 100).toFixed(1)}% (${this.getPositionRegime(position.marketId)}) - cutting loss early`,
                urgency: 'HIGH',
                remainingPosition: {
                    entryPrice: position.entryPrice,
                    remainingShares: position.size * 0.5,
                    adjustedStopLoss: position.entryPrice * (1 + thresholds.stopLoss),  // Keep original stop
                    adjustedTakeProfit: position.entryPrice * 1.05  // Lowered target to breakeven + 5%
                }
            };
        }
        
        return null;
    }

    /**
     * Clean up all tracking for a position
     */
    private cleanupPositionTracking(positionId: string): void {
        this.positionHighWaterMark.delete(positionId);
        this.partialExitStatus.delete(positionId);
        this.positionRegime.delete(positionId);
    }
}
