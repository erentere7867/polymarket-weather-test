/**
 * Portfolio Heat Manager
 * Tracks exposure and enforces risk limits
 * In-memory only - no database
 *
 * Integrates with DrawdownKillSwitch for risk control
 */

import { StrategyType } from './strategy-orchestrator.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { DrawdownKillSwitch } from './drawdown-kill-switch.js';

interface Position {
  marketId: string;
  size: number;
  strategy: StrategyType;
  entryTime: Date;
  correlatedMarkets: string[];
}

interface ExposureMetrics {
  totalExposure: number;
  totalHeat: number;
  correlatedExposure: number;
  diversificationScore: number;
  cashReserve: number;
}

export class PortfolioHeatManager {
  private initialCapital: number;
  private currentCapital: number;
  private positions: Map<string, Position> = new Map();
  private correlationMatrix: Map<string, Set<string>> = new Map();
  
  // Kill switch integration
  private killSwitch: DrawdownKillSwitch;

  // Limits
  private readonly MAX_HEAT = config.MAX_KELLY_HEAT || 0.30;
  private readonly MAX_EXPOSURE = config.MAX_PORTFOLIO_EXPOSURE || 0.50;
  private readonly MIN_CASH = config.MIN_CASH_RESERVE || 0.10;
  private readonly MAX_SINGLE_POSITION = 0.15;

  constructor(initialCapital: number) {
    this.initialCapital = initialCapital;
    this.currentCapital = initialCapital;
    
    // Initialize kill switch with the same capital
    this.killSwitch = DrawdownKillSwitch.getInstance(initialCapital);
  }

  /**
   * Update current capital (called when PnL changes)
   */
  updateCapital(newCapital: number): void {
    this.currentCapital = newCapital;
    
    // Also update kill switch capital
    this.killSwitch.setCapital(newCapital);
  }

  /**
   * Add a new position
   */
  addPosition(marketId: string, size: number, strategy: StrategyType): boolean {
    if (!this.canAddPosition(marketId, size)) {
      return false;
    }

    const position: Position = {
      marketId,
      size,
      strategy,
      entryTime: new Date(),
      correlatedMarkets: this.findCorrelatedMarkets(marketId),
    };

    this.positions.set(marketId, position);
    this.updateCorrelationMatrix(marketId);

    logger.info(`[PortfolioHeat] Added position ${marketId}`, {
      size,
      strategy,
      currentHeat: this.getCurrentHeat().toFixed(3),
    });

    return true;
  }

  /**
   * Remove a position
   */
  removePosition(marketId: string): void {
    this.positions.delete(marketId);
    this.correlationMatrix.delete(marketId);
    
    // Update other positions' correlations
    for (const pos of this.positions.values()) {
      pos.correlatedMarkets = this.findCorrelatedMarkets(pos.marketId);
    }
  }

  /**
   * Check if we can add a position
   * Now includes kill switch check as first line of defense
   */
  canAddPosition(marketId: string, size: number): boolean {
    // CRITICAL: Check kill switch first
    if (this.killSwitch.shouldHaltTrading()) {
      logger.warn(`[PortfolioHeat] Rejected: Kill switch is active`, {
        killSwitchState: this.killSwitch.getState()
      });
      return false;
    }
    
    // Log warning if approaching thresholds
    const warningStatus = this.killSwitch.getWarningStatus();
    if (warningStatus.isWarning) {
      logger.warn(`[PortfolioHeat] Warning: Approaching kill switch thresholds`, {
        warnings: warningStatus.warnings
      });
    }

    // Check if already have position
    if (this.positions.has(marketId)) {
      return false;
    }

    // Check single position limit
    const positionRatio = size / this.currentCapital;
    if (positionRatio > this.MAX_SINGLE_POSITION) {
      logger.debug(`[PortfolioHeat] Rejected: Position size ${positionRatio.toFixed(2)} exceeds max ${this.MAX_SINGLE_POSITION}`);
      return false;
    }

    // Check total exposure
    const currentExposure = this.getTotalExposure();
    const newExposure = (currentExposure + size) / this.currentCapital;
    if (newExposure > this.MAX_EXPOSURE) {
      logger.debug(`[PortfolioHeat] Rejected: Would exceed exposure limit ${this.MAX_EXPOSURE}`);
      return false;
    }

    // Check cash reserve
    const cashNeeded = size;
    const remainingCash = this.currentCapital - currentExposure - cashNeeded;
    const cashRatio = remainingCash / this.currentCapital;
    if (cashRatio < this.MIN_CASH) {
      logger.debug(`[PortfolioHeat] Rejected: Would violate cash reserve ${this.MIN_CASH}`);
      return false;
    }

    // Check heat limit
    const currentHeat = this.getCurrentHeat();
    const positionHeat = size / this.currentCapital;
    if (currentHeat + positionHeat > this.MAX_HEAT) {
      logger.debug(`[PortfolioHeat] Rejected: Would exceed heat limit ${this.MAX_HEAT}`);
      return false;
    }

    // Check correlation exposure
    const correlatedExposure = this.calculateCorrelatedExposure(marketId);
    const newCorrelatedExposure = correlatedExposure + size;
    const maxCorrelatedExposure = this.currentCapital * 0.20;  // Max 20% in correlated
    if (newCorrelatedExposure > maxCorrelatedExposure) {
      logger.debug(`[PortfolioHeat] Rejected: Would exceed correlated exposure limit`);
      return false;
    }

    return true;
  }

  /**
   * Get current portfolio heat (sum of Kelly fractions)
   */
  getCurrentHeat(): number {
    let heat = 0;
    for (const pos of this.positions.values()) {
      heat += pos.size / this.currentCapital;
    }
    return heat;
  }

  /**
   * Get total exposure
   */
  getTotalExposure(): number {
    let exposure = 0;
    for (const pos of this.positions.values()) {
      exposure += pos.size;
    }
    return exposure;
  }

  /**
   * Calculate exposure to correlated markets for a new position
   */
  private calculateCorrelatedExposure(marketId: string): number {
    const correlated = this.findCorrelatedMarkets(marketId);
    let exposure = 0;

    for (const pos of this.positions.values()) {
      if (correlated.includes(pos.marketId) || this.areMarketsCorrelated(marketId, pos.marketId)) {
        exposure += pos.size;
      }
    }

    return exposure;
  }

  /**
   * Find correlated markets
   */
  private findCorrelatedMarkets(marketId: string): string[] {
    const correlated: string[] = [];

    for (const existingId of this.positions.keys()) {
      if (this.areMarketsCorrelated(marketId, existingId)) {
        correlated.push(existingId);
      }
    }

    return correlated;
  }

  /**
   * Determine if two markets are correlated
   */
  private areMarketsCorrelated(a: string, b: string): boolean {
    // Extract city from market ID (simplified)
    const cityA = this.extractCityFromMarketId(a);
    const cityB = this.extractCityFromMarketId(b);

    if (cityA && cityB && cityA === cityB) {
      return true;
    }

    // Check cached correlation
    const correlatedSet = this.correlationMatrix.get(a);
    if (correlatedSet?.has(b)) {
      return true;
    }

    return false;
  }

  /**
   * Extract city from market ID (simplified heuristic)
   */
  private extractCityFromMarketId(marketId: string): string | null {
    // This is a simplified version - in practice you'd use market metadata
    const parts = marketId.toLowerCase().split('-');
    return parts[0] || null;
  }

  /**
   * Update correlation matrix
   */
  private updateCorrelationMatrix(marketId: string): void {
    const correlated = new Set<string>();

    for (const existingId of this.positions.keys()) {
      if (existingId !== marketId && this.areMarketsCorrelated(marketId, existingId)) {
        correlated.add(existingId);
      }
    }

    this.correlationMatrix.set(marketId, correlated);
  }

  /**
   * Get comprehensive exposure metrics
   */
  getExposureMetrics(): ExposureMetrics {
    const totalExposure = this.getTotalExposure();
    const totalHeat = this.getCurrentHeat();
    const cashReserve = (this.currentCapital - totalExposure) / this.currentCapital;

    // Calculate correlated exposure
    let correlatedExposure = 0;
    const processedPairs = new Set<string>();

    for (const [idA, posA] of this.positions) {
      for (const [idB, posB] of this.positions) {
        if (idA >= idB) continue;  // Avoid double counting

        const pairKey = `${idA}-${idB}`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);

        if (this.areMarketsCorrelated(idA, idB)) {
          correlatedExposure += posA.size + posB.size;
        }
      }
    }

    // Diversification score: 1.0 = perfectly diversified, 0.0 = all correlated
    const diversificationScore = totalExposure > 0
      ? 1 - (correlatedExposure / (totalExposure * 2))
      : 1.0;

    return {
      totalExposure,
      totalHeat,
      correlatedExposure,
      diversificationScore,
      cashReserve,
    };
  }

  /**
   * Get positions summary
   */
  getPositionsSummary(): Array<{
    marketId: string;
    size: number;
    strategy: StrategyType;
    entryTime: Date;
    correlatedCount: number;
  }> {
    return Array.from(this.positions.values()).map(pos => ({
      marketId: pos.marketId,
      size: pos.size,
      strategy: pos.strategy,
      entryTime: pos.entryTime,
      correlatedCount: pos.correlatedMarkets.length,
    }));
  }

  /**
   * Check if we should reduce exposure
   */
  shouldReduceExposure(): boolean {
    const metrics = this.getExposureMetrics();

    // Reduce if heat too high
    if (metrics.totalHeat > this.MAX_HEAT * 0.9) return true;

    // Reduce if correlated exposure too high
    if (metrics.correlatedExposure > this.currentCapital * 0.18) return true;

    // Reduce if diversification too low
    if (metrics.diversificationScore < 0.5) return true;

    return false;
  }

  /**
   * Get positions to reduce (sorted by priority)
   */
  getPositionsToReduce(): string[] {
    const positions = Array.from(this.positions.values());

    // Sort by: size (largest first), then by correlation (more correlated first)
    positions.sort((a, b) => {
      const sizeDiff = b.size - a.size;
      if (sizeDiff !== 0) return sizeDiff;

      return b.correlatedMarkets.length - a.correlatedMarkets.length;
    });

    return positions.map(p => p.marketId);
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.positions.clear();
    this.correlationMatrix.clear();
    this.currentCapital = this.initialCapital;
  }
  
  /**
   * Get the kill switch instance for direct access
   */
  getKillSwitch(): DrawdownKillSwitch {
    return this.killSwitch;
  }
  
  /**
   * Record a trade result for kill switch monitoring
   */
  recordTradeResult(pnl: number, capitalAfter?: number): void {
    this.killSwitch.recordTradeResult(pnl, capitalAfter);
    
    // Update our capital tracking
    if (capitalAfter !== undefined) {
      this.currentCapital = capitalAfter;
    }
  }
  
  /**
   * Get kill switch status summary
   */
  getKillSwitchStatus(): string {
    return this.killSwitch.getStatusSummary();
  }
}

export default PortfolioHeatManager;
