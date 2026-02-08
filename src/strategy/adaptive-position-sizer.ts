/**
 * Adaptive Position Sizer
 * Dynamic Kelly Criterion with performance feedback
 * No database - in-memory learning
 */

import { StrategySignal, StrategyPerformance, StrategyType } from './strategy-orchestrator.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface PositionSize {
  size: number;
  heatContribution: number;
  kellyFraction: number;
  confidence: number;
}

export class AdaptivePositionSizer {
  // Kelly fractions by confidence level
  private kellyFractions = {
    guaranteed: 0.75,   // 3/4 Kelly for σ > 3.0
    high: 0.50,         // 1/2 Kelly for σ > 2.0
    medium: 0.25,       // 1/4 Kelly for σ > 1.0
    low: 0.125,         // 1/8 Kelly for σ > 0.5
    minimal: 0.05,      // 1/20 Kelly for low confidence
  };

  // Performance-based multipliers
  private performanceMultipliers: Map<StrategyType, number> = new Map();

  // Volatility regime adjustments
  private volatilityMultiplier = 1.0;

  constructor() {
    // Initialize multipliers
    const strategies: StrategyType[] = [
      'CERTAINTY_ARBITRAGE',
      'CONFIDENCE_COMPRESSION',
      'CROSS_MARKET_LAG',
      'TIME_DECAY',
      'MODEL_DIVERGENCE',
    ];

    for (const strategy of strategies) {
      this.performanceMultipliers.set(strategy, 1.0);
    }
  }

  /**
   * Calculate position size for a signal
   */
  calculatePositionSize(
    signal: StrategySignal,
    currentCapital: number,
    performance: StrategyPerformance
  ): PositionSize {
    // 1. Calculate base Kelly fraction
    const baseKelly = this.calculateKellyFraction(signal);

    // 2. Apply performance multiplier
    const perfMultiplier = this.getPerformanceMultiplier(signal.strategy, performance);

    // 3. Apply volatility adjustment
    const volMultiplier = this.volatilityMultiplier;

    // 4. Apply edge quality multiplier
    const edgeMultiplier = this.calculateEdgeMultiplier(signal);

    // 5. Apply time decay penalty
    const timeMultiplier = this.calculateTimeMultiplier(signal);

    // Calculate final Kelly fraction
    const kellyFraction = baseKelly * perfMultiplier * volMultiplier * edgeMultiplier * timeMultiplier;

    // 6. Calculate position size in currency
    const maxPosition = config.maxPositionSize;
    const kellyPosition = currentCapital * kellyFraction;
    
    // Cap at max position size
    const position = Math.min(maxPosition, kellyPosition);

    // 7. Ensure minimum viable position
    if (position < 5) {
      return {
        size: 0,
        heatContribution: 0,
        kellyFraction: 0,
        confidence: signal.confidence,
      };
    }

    logger.debug(`[PositionSizer] Calculated position for ${signal.strategy}`, {
      baseKelly: baseKelly.toFixed(3),
      perfMultiplier: perfMultiplier.toFixed(2),
      volMultiplier: volMultiplier.toFixed(2),
      edgeMultiplier: edgeMultiplier.toFixed(2),
      timeMultiplier: timeMultiplier.toFixed(2),
      finalKelly: kellyFraction.toFixed(3),
      position: position.toFixed(2),
    });

    return {
      size: Math.floor(position),
      heatContribution: kellyFraction,
      kellyFraction,
      confidence: signal.confidence,
    };
  }

  /**
   * Calculate base Kelly fraction based on signal characteristics
   */
  private calculateKellyFraction(signal: StrategySignal): number {
    const sigma = this.extractSigma(signal);

    if (signal.opportunity.isGuaranteed || sigma >= 3.0) {
      return this.kellyFractions.guaranteed;
    } else if (sigma >= 2.0) {
      return this.kellyFractions.high;
    } else if (sigma >= 1.0) {
      return this.kellyFractions.medium;
    } else if (sigma >= 0.5) {
      return this.kellyFractions.low;
    } else {
      return this.kellyFractions.minimal;
    }
  }

  /**
   * Get performance-based multiplier
   */
  private getPerformanceMultiplier(
    strategy: StrategyType,
    performance: StrategyPerformance
  ): number {
    let multiplier = this.performanceMultipliers.get(strategy) || 1.0;

    if (performance.trades < 5) {
      return multiplier * 0.8;  // Be conservative with new strategies
    }

    // Adjust based on win rate
    if (performance.winRate > 0.85) {
      multiplier *= 1.3;  // Boost high performers
    } else if (performance.winRate > 0.70) {
      multiplier *= 1.1;
    } else if (performance.winRate < 0.50) {
      multiplier *= 0.6;  // Reduce poor performers
    } else if (performance.winRate < 0.65) {
      multiplier *= 0.8;
    }

    // Adjust based on streak
    if (performance.streak >= 5) {
      multiplier *= 1.2;  // Hot streak bonus
    } else if (performance.streak <= -5) {
      multiplier *= 0.7;  // Cold streak penalty
    }

    // Cap multiplier
    return Math.max(0.3, Math.min(2.0, multiplier));
  }

  /**
   * Calculate edge quality multiplier
   */
  private calculateEdgeMultiplier(signal: StrategySignal): number {
    const edge = Math.abs(signal.opportunity.edge);

    if (edge > 0.15) return 1.3;
    if (edge > 0.10) return 1.15;
    if (edge > 0.07) return 1.0;
    if (edge > 0.05) return 0.85;
    return 0.7;
  }

  /**
   * Calculate time decay multiplier
   */
  private calculateTimeMultiplier(signal: StrategySignal): number {
    const snapshotTime = signal.opportunity.snapshotTimestamp?.getTime() || Date.now();
    const ageMs = Date.now() - snapshotTime;
    const ageMinutes = ageMs / 60000;

    // Exponential decay: 1.0 at t=0, 0.5 at 1 minute
    const decay = Math.exp(-ageMinutes * 0.693);

    return Math.max(0.3, decay);
  }

  /**
   * Extract sigma from signal
   */
  private extractSigma(signal: StrategySignal): number {
    return signal.opportunity.certaintySigma || 0;
  }

  /**
   * Update performance multiplier for a strategy
   */
  updatePerformanceMultiplier(strategy: StrategyType, performance: StrategyPerformance): void {
    const current = this.performanceMultipliers.get(strategy) || 1.0;
    const target = this.getPerformanceMultiplier(strategy, performance);
    
    // Smooth transition
    const smoothed = current * 0.7 + target * 0.3;
    this.performanceMultipliers.set(strategy, smoothed);
  }

  /**
   * Set volatility regime multiplier
   */
  setVolatilityRegime(regime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'): void {
    switch (regime) {
      case 'LOW':
        this.volatilityMultiplier = 1.2;
        break;
      case 'MEDIUM':
        this.volatilityMultiplier = 1.0;
        break;
      case 'HIGH':
        this.volatilityMultiplier = 0.75;
        break;
      case 'EXTREME':
        this.volatilityMultiplier = 0.5;
        break;
    }

    logger.info(`[PositionSizer] Volatility regime set to ${regime}`, {
      multiplier: this.volatilityMultiplier,
    });
  }

  /**
   * Get current configuration
   */
  getConfig(): {
    kellyFractions: { guaranteed: number; high: number; medium: number; low: number; minimal: number };
    volatilityMultiplier: number;
    performanceMultipliers: Record<StrategyType, number>;
  } {
    return {
      kellyFractions: { ...this.kellyFractions },
      volatilityMultiplier: this.volatilityMultiplier,
      performanceMultipliers: Object.fromEntries(this.performanceMultipliers) as Record<StrategyType, number>,
    };
  }

  /**
   * Reset sizer state
   */
  reset(): void {
    this.performanceMultipliers.clear();
    const strategies: StrategyType[] = [
      'CERTAINTY_ARBITRAGE',
      'CONFIDENCE_COMPRESSION',
      'CROSS_MARKET_LAG',
      'TIME_DECAY',
      'MODEL_DIVERGENCE',
    ];

    for (const strategy of strategies) {
      this.performanceMultipliers.set(strategy, 1.0);
    }

    this.volatilityMultiplier = 1.0;
  }
}

export default AdaptivePositionSizer;
