import { MarketModel } from '../probability/market-model.js';
import { logger } from '../logger.js';
import { EXIT_CONFIG } from '../config.js';
import { DataStore } from '../realtime/data-store.js';
import { SimulatedPosition } from '../simulation/portfolio.js';

export interface ExitCheckResult {
    shouldExit: boolean;
    reason?: string;
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface Position {
    marketId: string;
    side: 'yes' | 'no';
    entryPrice: number;
    currentPrice: number;
    size: number;
    entryTime: Date;
    pnl: number;
    pnlPercent: number;
    entryForecastProb?: number;
}

export interface ExitSignal {
    shouldExit: boolean;
    reason?: string;
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
    limitPrice?: number;
    isPartialExit?: boolean;
    percentToExit?: number;
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
    private store: DataStore;

    private takeProfitThreshold: number = EXIT_CONFIG.TAKE_PROFIT_THRESHOLD;
    private stopLossThreshold: number = EXIT_CONFIG.STOP_LOSS_THRESHOLD;
    private timeLimitMs: number = 12 * 60 * 60 * 1000;

    private regimeConfig: Record<VolatilityRegime, RegimeThresholds> = {
        TRENDING_UP: {
            takeProfit: EXIT_CONFIG.REGIME_TAKE_PROFIT_TRENDING,
            stopLoss: EXIT_CONFIG.REGIME_STOP_LOSS_TRENDING,
            trailingStop: true,
            partialExit: true
        },
        TRENDING_DOWN: {
            takeProfit: EXIT_CONFIG.REGIME_TAKE_PROFIT_TRENDING,
            stopLoss: EXIT_CONFIG.REGIME_STOP_LOSS_TRENDING,
            trailingStop: false,
            partialExit: true
        },
        RANGING: {
            takeProfit: EXIT_CONFIG.REGIME_TAKE_PROFIT_RANGING,
            stopLoss: EXIT_CONFIG.REGIME_STOP_LOSS_RANGING,
            trailingStop: false,
            partialExit: true
        },
        VOLATILE: {
            takeProfit: EXIT_CONFIG.REGIME_TAKE_PROFIT_TRENDING * 1.2,
            stopLoss: EXIT_CONFIG.REGIME_STOP_LOSS_TRENDING * 1.2,
            trailingStop: true,
            partialExit: true
        },
        UNKNOWN: {
            takeProfit: EXIT_CONFIG.TAKE_PROFIT_THRESHOLD,
            stopLoss: EXIT_CONFIG.STOP_LOSS_THRESHOLD,
            trailingStop: true,
            partialExit: true
        }
    };

    private trailingStopEnabled: boolean = true;
    private trailingStopActivationPercent: number = EXIT_CONFIG.TRAILING_STOP_TRIGGER;
    private trailingStopDistance: number = EXIT_CONFIG.TRAILING_STOP_DISTANCE;

    private positionHighWaterMark: Map<string, number> = new Map();
    private partialExitStatus: Map<string, PartialExitStatus> = new Map();
    private positionRegime: Map<string, VolatilityRegime> = new Map();

    private priceHistory: Map<string, { price: number; timestamp: number }[]> = new Map();
    private readonly STABILITY_WINDOW_MS = 30000;
    private readonly STABILITY_THRESHOLD = 0.005;

    constructor(marketModel: MarketModel, store?: DataStore) {
        this.marketModel = marketModel;
        this.store = store as DataStore;
    }

    public cleanupPosition(marketId: string): void {
        this.positionHighWaterMark.delete(marketId);
        this.partialExitStatus.delete(marketId);
        this.positionRegime.delete(marketId);
        this.priceHistory.delete(marketId);
    }

    setPositionRegime(positionId: string, regime: VolatilityRegime): void {
        this.positionRegime.set(positionId, regime);
    }

    private getPositionRegime(positionId: string): VolatilityRegime {
        return this.positionRegime.get(positionId) || 'UNKNOWN';
    }

    private getRegimeThresholds(positionId: string): RegimeThresholds {
        const regime = this.getPositionRegime(positionId);
        return this.regimeConfig[regime];
    }

    markPartialExit(positionId: string, percentExited: number): void {
        const current = this.partialExitStatus.get(positionId) || { exitedPercent: 0 };
        current.exitedPercent += percentExited;
        this.partialExitStatus.set(positionId, current);
    }

    private hasPartiallyExited(positionId: string): boolean {
        const status = this.partialExitStatus.get(positionId);
        return (status?.exitedPercent || 0) > 0;
    }

    updateConfig(takeProfit: number, stopLoss: number): void {
        const validatedTakeProfit = Math.max(0.01, Math.min(1.0, takeProfit));
        const validatedStopLoss = Math.max(-1.0, Math.min(-0.01, stopLoss));

        if (validatedTakeProfit <= Math.abs(validatedStopLoss)) {
            logger.warn(`ExitOptimizer: takeProfit (${validatedTakeProfit}) must be > |stopLoss| (${Math.abs(validatedStopLoss)}). Adjusting to maintain 2:1 ratio.`);
            if (validatedStopLoss < 0) {
                const minTakeProfit = Math.abs(validatedStopLoss) * 2;
                this.takeProfitThreshold = Math.max(validatedTakeProfit, minTakeProfit);
            }
        } else {
            this.takeProfitThreshold = validatedTakeProfit;
        }

        this.stopLossThreshold = validatedStopLoss;
        logger.info(`ExitOptimizer config updated: TP=${(this.takeProfitThreshold * 100).toFixed(1)}%, SL=${(this.stopLossThreshold * 100).toFixed(1)}%`);
    }

    updateRegimeConfig(
        regime: VolatilityRegime,
        thresholds: Partial<RegimeThresholds>
    ): void {
        this.regimeConfig[regime] = { ...this.regimeConfig[regime], ...thresholds };
        logger.info(`[ExitOptimizer] Updated ${regime} regime: TP=${(this.regimeConfig[regime].takeProfit * 100).toFixed(0)}%, SL=${(this.regimeConfig[regime].stopLoss * 100).toFixed(0)}%`);
    }

    getConfig(): { takeProfit: number; stopLoss: number } {
        return {
            takeProfit: this.takeProfitThreshold,
            stopLoss: this.stopLossThreshold
        };
    }

    private detectPriceStability(marketId: string, currentPrice: number): boolean {
        const now = Date.now();
        let history = this.priceHistory.get(marketId) || [];

        history.push({ price: currentPrice, timestamp: now });

        history = history.filter(p => now - p.timestamp < this.STABILITY_WINDOW_MS);
        this.priceHistory.set(marketId, history);

        if (history.length < 5) return false;

        const prices = history.map(p => p.price);
        const maxPrice = Math.max(...prices);
        const minPrice = Math.min(...prices);
        const range = maxPrice - minPrice;

        return range < this.STABILITY_THRESHOLD;
    }

    private calculatePnlPercent(position: SimulatedPosition): number {
        return (position.currentPrice - position.entryPrice) / position.entryPrice;
    }

    private checkTrailingStop(position: SimulatedPosition, trailDistance: number): ExitCheckResult | null {
        if (!this.trailingStopEnabled) return null;

        const pnlPercent = this.calculatePnlPercent(position);
        const currentHigh = this.positionHighWaterMark.get(position.marketId) || 0;

        if (pnlPercent > currentHigh) {
            this.positionHighWaterMark.set(position.marketId, pnlPercent);
        }

        const highWaterMark = this.positionHighWaterMark.get(position.marketId) || 0;

        if (highWaterMark >= this.trailingStopActivationPercent) {
            const trailingStopLevel = highWaterMark - trailDistance;

            if (pnlPercent <= trailingStopLevel) {
                const lockedInProfit = (highWaterMark - trailDistance) * 100;
                this.positionHighWaterMark.delete(position.marketId);
                return {
                    shouldExit: true,
                    reason: `Trailing stop: locked in ${lockedInProfit.toFixed(1)}%`,
                    urgency: 'HIGH'
                };
            }
        }

        return null;
    }

    private checkForecastReversalExit(
        position: SimulatedPosition,
        threshold: number
    ): ExitCheckResult | null {
        if (position.entryForecastValue === undefined) return null;

        const state = this.store?.getMarketState(position.marketId);
        if (!state?.lastForecast) return null;

        const currentForecast = state.lastForecast.forecastValue;
        const entryForecast = position.entryForecastValue;

        const market = state.market;

        if (market?.comparisonType === 'range' && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
            const minF = market.thresholdUnit === 'C'
                ? (market.minThreshold * 9 / 5) + 32
                : market.minThreshold;
            const maxF = market.thresholdUnit === 'C'
                ? (market.maxThreshold * 9 / 5) + 32
                : market.maxThreshold;

            const wasInRange = entryForecast >= minF && entryForecast <= maxF;
            const nowInRange = currentForecast >= minF && currentForecast <= maxF;

            if (position.side === 'yes') {
                if (wasInRange && !nowInRange) {
                    return {
                        shouldExit: true,
                        reason: `Forecast moved OUT of range [${minF.toFixed(1)}, ${maxF.toFixed(1)}]: ${entryForecast.toFixed(1)}°F → ${currentForecast.toFixed(1)}°F`,
                        urgency: 'HIGH'
                    };
                }
            } else {
                if (!wasInRange && nowInRange) {
                    return {
                        shouldExit: true,
                        reason: `Forecast moved INTO range [${minF.toFixed(1)}, ${maxF.toFixed(1)}]: ${entryForecast.toFixed(1)}°F → ${currentForecast.toFixed(1)}°F`,
                        urgency: 'HIGH'
                    };
                }
            }

            return null;
        }

        if (position.side === 'yes') {
            if (currentForecast < entryForecast - threshold) {
                return {
                    shouldExit: true,
                    reason: `Forecast reversal: ${entryForecast.toFixed(2)} → ${currentForecast.toFixed(2)} (against YES)`,
                    urgency: 'HIGH'
                };
            }
        } else {
            if (currentForecast > entryForecast + threshold) {
                return {
                    shouldExit: true,
                    reason: `Forecast reversal: ${entryForecast.toFixed(2)} → ${currentForecast.toFixed(2)} (against NO)`,
                    urgency: 'HIGH'
                };
            }
        }

        return null;
    }

    private checkGuaranteedExit(position: SimulatedPosition): ExitCheckResult | null {
        const pnlPercent = this.calculatePnlPercent(position);

        const reversal = this.checkForecastReversalExit(position, 0.10);
        if (reversal) return reversal;

        const currentPrice = position.currentPrice;
        if (position.side === 'yes' && currentPrice >= 0.90) {
            return { shouldExit: true, reason: 'Near resolution (0.90)', urgency: 'MEDIUM' };
        }
        if (position.side === 'no' && currentPrice <= 0.10) {
            return { shouldExit: true, reason: 'Near resolution (0.10)', urgency: 'MEDIUM' };
        }

        if (pnlPercent > 0.15) {
            const trailResult = this.checkTrailingStop(position, 0.10);
            if (trailResult) return trailResult;
        }

        if (pnlPercent <= -0.15) {
            return { shouldExit: true, reason: 'Stop loss (-15%)', urgency: 'HIGH' };
        }

        return null;
    }

    private checkHighConfidenceExit(position: SimulatedPosition): ExitCheckResult | null {
        const pnlPercent = this.calculatePnlPercent(position);

        const reversal = this.checkForecastReversalExit(position, 0.08);
        if (reversal) return reversal;

        if (pnlPercent >= 0.25) {
            return { shouldExit: true, reason: 'Take profit (25%)', urgency: 'MEDIUM' };
        }

        if (pnlPercent > 0.10) {
            const trailResult = this.checkTrailingStop(position, 0.07);
            if (trailResult) return trailResult;
        }

        if (pnlPercent <= -0.12) {
            return { shouldExit: true, reason: 'Stop loss (-12%)', urgency: 'HIGH' };
        }

        return null;
    }

    private checkForecastChangeExit(position: SimulatedPosition): ExitCheckResult | null {
        const pnlPercent = this.calculatePnlPercent(position);

        const reversal = this.checkForecastReversalExit(position, 0.05);
        if (reversal) return reversal;

        if (this.detectPriceStability(position.marketId, position.currentPrice)) {
            if (pnlPercent > 0.02) {
                return { shouldExit: true, reason: 'Price stabilized', urgency: 'MEDIUM' };
            }
        }

        if (pnlPercent >= 0.20) {
            return { shouldExit: true, reason: 'Take profit (20%)', urgency: 'MEDIUM' };
        }

        if (pnlPercent > 0.08) {
            const trailResult = this.checkTrailingStop(position, 0.05);
            if (trailResult) return trailResult;
        }

        if (pnlPercent <= -0.08) {
            return { shouldExit: true, reason: 'Stop loss (-8%)', urgency: 'HIGH' };
        }

        return null;
    }

    checkExit(position: SimulatedPosition, currentPrice: number): ExitCheckResult {
        position.currentPrice = currentPrice;

        const sigma = position.sigma || 1.0;
        const signalType = position.signalType || 'standard';

        if (sigma >= 3.0) {
            const guaranteedExit = this.checkGuaranteedExit(position);
            if (guaranteedExit) return guaranteedExit;
            return { shouldExit: false, reason: 'Holding guaranteed position' };
        }

        if (sigma >= 2.0) {
            const highExit = this.checkHighConfidenceExit(position);
            if (highExit) return highExit;
            return { shouldExit: false, reason: 'Holding high confidence position' };
        }

        if (signalType === 'forecast_change') {
            const changeExit = this.checkForecastChangeExit(position);
            if (changeExit) return changeExit;
            return { shouldExit: false, reason: 'Holding forecast change position' };
        }

        return this.checkStandardExit(position);
    }

    private checkStandardExit(position: SimulatedPosition): ExitCheckResult {
        const thresholds = this.getRegimeThresholds(position.marketId);
        const pnlPercent = this.calculatePnlPercent(position);

        if (thresholds.trailingStop) {
            const trailResult = this.checkTrailingStop(position, this.trailingStopDistance);
            if (trailResult) return trailResult;
        }

        if (position.entryForecastValue !== undefined && this.store) {
            const state = this.store.getMarketState(position.marketId);
            if (state?.lastForecast) {
                const currentForecast = state.lastForecast.forecastValue;
                const entryForecast = position.entryForecastValue;

                let forecastMovedAgainst = false;
                let forecastMovePercent = 0;

                if (position.side === 'yes') {
                    forecastMovePercent = entryForecast - currentForecast;
                    forecastMovedAgainst = forecastMovePercent >= EXIT_CONFIG.FORECAST_REVERSAL_THRESHOLD;
                } else {
                    const entryNoProb = 1 - entryForecast;
                    const currentNoProb = 1 - currentForecast;
                    forecastMovePercent = currentNoProb - entryNoProb;
                    forecastMovedAgainst = forecastMovePercent >= EXIT_CONFIG.FORECAST_REVERSAL_THRESHOLD;
                }

                if (forecastMovedAgainst) {
                    return {
                        shouldExit: true,
                        reason: `Forecast reversal: moved ${(Math.abs(forecastMovePercent) * 100).toFixed(1)}% against ${position.side}`,
                        urgency: 'HIGH'
                    };
                }
            }
        }

        const adjustedStopLoss = this.hasPartiallyExited(position.marketId)
            ? thresholds.stopLoss * 0.8
            : thresholds.stopLoss;

        if (pnlPercent <= adjustedStopLoss) {
            return {
                shouldExit: true,
                reason: `Stop Loss hit (${this.getPositionRegime(position.marketId)}): ${(pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        const adjustedTakeProfit = this.hasPartiallyExited(position.marketId)
            ? thresholds.takeProfit * 1.2
            : thresholds.takeProfit;

        if (pnlPercent >= adjustedTakeProfit) {
            return {
                shouldExit: true,
                reason: `Take Profit hit (${this.getPositionRegime(position.marketId)}): ${(pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        const holdTimeMs = Date.now() - position.entryTime.getTime();
        if (holdTimeMs > this.timeLimitMs) {
            return {
                shouldExit: true,
                reason: `Time limit exceeded (${(holdTimeMs / 3600000).toFixed(1)}h)`,
                urgency: 'LOW'
            };
        }

        return { shouldExit: false };
    }

    private updateHighWaterMark(position: Position): void {
        const currentHigh = this.positionHighWaterMark.get(position.marketId) || 0;
        if (position.pnlPercent > currentHigh) {
            this.positionHighWaterMark.set(position.marketId, position.pnlPercent);
        }
    }

    private checkTrailingStopLegacy(position: Position): ExitSignal | null {
        if (!this.trailingStopEnabled) return null;

        this.updateHighWaterMark(position);
        const highWaterMark = this.positionHighWaterMark.get(position.marketId) || 0;

        if (highWaterMark >= this.trailingStopActivationPercent) {
            const trailingStopLevel = highWaterMark - this.trailingStopDistance;

            if (position.pnlPercent <= trailingStopLevel) {
                const lockedInProfit = (highWaterMark - this.trailingStopDistance) * 100;
                this.positionHighWaterMark.delete(position.marketId);
                return {
                    shouldExit: true,
                    reason: `Trailing Stop triggered: PnL ${(position.pnlPercent * 100).toFixed(1)}% dropped from high ${(highWaterMark * 100).toFixed(1)}%, locked in ${lockedInProfit.toFixed(1)}%`,
                    urgency: 'HIGH'
                };
            }
        }

        return null;
    }

    clearPosition(marketId: string): void {
        this.positionHighWaterMark.delete(marketId);
    }

    checkForecastBasedExit(
        position: Position,
        currentForecastProb: number,
        entryForecastProb?: number
    ): ExitSignal | null {
        const currentPrice = position.currentPrice;
        const entryPrice = position.entryPrice;

        const entryProb = entryForecastProb ?? position.entryForecastProb;

        const fairValue = currentForecastProb;

        const isOvervalued = position.side === 'yes'
            ? currentPrice >= fairValue
            : currentPrice <= fairValue;

        if (entryProb !== undefined) {
            let forecastMovedAgainst = false;
            let forecastMovePercent = 0;

            if (position.side === 'yes') {
                forecastMovePercent = entryProb - currentForecastProb;
                forecastMovedAgainst = forecastMovePercent >= EXIT_CONFIG.FORECAST_REVERSAL_THRESHOLD;
            } else {
                const entryNoProb = 1 - entryProb;
                const currentNoProb = 1 - currentForecastProb;
                forecastMovePercent = currentNoProb - entryNoProb;
                forecastMovedAgainst = forecastMovePercent >= EXIT_CONFIG.FORECAST_REVERSAL_THRESHOLD;
            }

            if (forecastMovedAgainst) {
                return {
                    shouldExit: true,
                    reason: `Forecast reversal: moved ${(Math.abs(forecastMovePercent) * 100).toFixed(1)}% against ${position.side} position (entry: ${(entryProb * 100).toFixed(1)}%, current: ${(currentForecastProb * 100).toFixed(1)}%)`,
                    urgency: 'HIGH'
                };
            }
        }

        if (isOvervalued && position.pnlPercent > 0) {
            return {
                shouldExit: true,
                reason: `Position overvalued: ${position.side} at ${(currentPrice * 100).toFixed(1)}% vs fair value ${(fairValue * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

        return null;
    }

    checkEdgeDecayExit(position: Position, entryTime?: Date): ExitSignal | null {
        const entry = entryTime ?? position.entryTime;
        const holdTimeMs = Date.now() - entry.getTime();

        const decayFactor = Math.exp(-holdTimeMs / EXIT_CONFIG.EDGE_DECAY_HALF_LIFE_MS * Math.LN2);

        if (decayFactor < 0.3 && position.pnlPercent > 0) {
            const holdTimeHours = holdTimeMs / (1000 * 60 * 60);
            return {
                shouldExit: true,
                reason: `Edge decayed: held ${holdTimeHours.toFixed(1)}h, decay factor ${(decayFactor * 100).toFixed(1)}% (below 30% threshold)`,
                urgency: 'MEDIUM'
            };
        }

        return null;
    }

    checkExitLegacy(position: Position, forecastProbability: number): ExitSignal {
        const thresholds = this.getRegimeThresholds(position.marketId);

        if (thresholds.trailingStop) {
            const trailingStopSignal = this.checkTrailingStopLegacy(position);
            if (trailingStopSignal) {
                return trailingStopSignal;
            }
        }

        const forecastExitSignal = this.checkForecastBasedExit(position, forecastProbability);
        if (forecastExitSignal) {
            this.cleanupPositionTracking(position.marketId);
            return forecastExitSignal;
        }

        const edgeDecaySignal = this.checkEdgeDecayExit(position);
        if (edgeDecaySignal) {
            this.cleanupPositionTracking(position.marketId);
            return edgeDecaySignal;
        }

        if (thresholds.partialExit && !this.hasPartiallyExited(position.marketId)) {
            const partialExitSignal = this.checkPartialExit(position, thresholds);
            if (partialExitSignal) {
                return partialExitSignal;
            }
        }

        const adjustedStopLoss = this.hasPartiallyExited(position.marketId)
            ? thresholds.stopLoss * 0.8
            : thresholds.stopLoss;

        if (position.pnlPercent <= adjustedStopLoss) {
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Stop Loss hit (${this.getPositionRegime(position.marketId)}): ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'HIGH'
            };
        }

        const fairValue = forecastProbability;
        const currentPrice = position.currentPrice;
        const hasMeaningfulProfit = position.pnlPercent > 0.01;

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

        const adjustedTakeProfit = this.hasPartiallyExited(position.marketId)
            ? thresholds.takeProfit * 1.2
            : thresholds.takeProfit;

        if (position.pnlPercent >= adjustedTakeProfit) {
            this.cleanupPositionTracking(position.marketId);
            return {
                shouldExit: true,
                reason: `Take Profit hit (${this.getPositionRegime(position.marketId)}): ${(position.pnlPercent * 100).toFixed(1)}%`,
                urgency: 'MEDIUM'
            };
        }

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

    private checkPartialExit(position: Position, thresholds: RegimeThresholds): ExitSignal | null {
        const partialWinThreshold = thresholds.takeProfit * 0.5;

        if (position.pnlPercent >= partialWinThreshold && position.pnlPercent < thresholds.takeProfit) {
            this.markPartialExit(position.marketId, 0.5);

            return {
                shouldExit: true,
                isPartialExit: true,
                percentToExit: 0.5,
                reason: `Partial WIN exit (50%) at ${(position.pnlPercent * 100).toFixed(1)}% profit (${this.getPositionRegime(position.marketId)})`,
                urgency: 'MEDIUM',
                remainingPosition: {
                    entryPrice: position.entryPrice,
                    remainingShares: position.size * 0.5,
                    adjustedStopLoss: position.entryPrice * EXIT_CONFIG.TRENDING_STOP_MULTIPLIER,
                    adjustedTakeProfit: position.entryPrice * (1 + thresholds.takeProfit * EXIT_CONFIG.TRENDING_TAKE_MULTIPLIER)
                }
            };
        }

        const partialLossThreshold = thresholds.stopLoss * 0.5;

        if (position.pnlPercent <= partialLossThreshold && position.pnlPercent > thresholds.stopLoss) {
            this.markPartialExit(position.marketId, 0.5);

            return {
                shouldExit: true,
                isPartialExit: true,
                percentToExit: 0.5,
                reason: `Partial LOSS exit (50%) at ${(position.pnlPercent * 100).toFixed(1)}% (${this.getPositionRegime(position.marketId)}) - cutting loss early`,
                urgency: 'HIGH',
                remainingPosition: {
                    entryPrice: position.entryPrice,
                    remainingShares: position.size * 0.5,
                    adjustedStopLoss: position.entryPrice * (1 + thresholds.stopLoss),
                    adjustedTakeProfit: position.entryPrice * 1.05
                }
            };
        }

        return null;
    }

    private cleanupPositionTracking(positionId: string): void {
        this.positionHighWaterMark.delete(positionId);
        this.partialExitStatus.delete(positionId);
        this.positionRegime.delete(positionId);
    }
}
