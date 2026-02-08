/**
 * Certainty Arbitrage Strategy
 * Trades only high-sigma (3+) opportunities with 99%+ certainty
 * Primary revenue driver - targets 25%+ returns per trade
 */

import { DataStore } from '../realtime/data-store.js';
import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { OpportunityDetector } from '../bot/opportunity-detector.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import type { EntrySignal } from './entry-optimizer.js';

export interface CertaintyOpportunity {
  market: ParsedWeatherMarket;
  opportunity: TradingOpportunity;
  sigma: number;
  certainty: number;
  expectedReturn: number;
  daysToEvent: number;
}

export class CertaintyArbitrageStrategy {
  private store: DataStore;
  private opportunityDetector: OpportunityDetector;
  
  // Track captured opportunities
  private capturedOpportunities: Map<string, {
    sigma: number;
    capturedAt: Date;
    forecastValue: number;
  }> = new Map();

  // Adaptive threshold based on performance
  private currentSigmaThreshold: number = 3.0;
  private recentTrades: Array<{sigma: number; pnl: number}> = [];

  constructor(store: DataStore, opportunityDetector: OpportunityDetector) {
    this.store = store;
    this.opportunityDetector = opportunityDetector;
  }

  /**
   * Detect high-certainty arbitrage opportunities
   */
  async detectOpportunities(markets: ParsedWeatherMarket[]): Promise<TradingOpportunity[]> {
    const opportunities: TradingOpportunity[] = [];

    for (const market of markets) {
      const opp = await this.analyzeMarket(market);
      if (opp && this.shouldTrade(opp)) {
        opportunities.push(opp.opportunity);
      }
    }

    // Sort by certainty (highest first)
    opportunities.sort((a, b) => {
      const sigmaA = this.getSigmaFromOpportunity(a);
      const sigmaB = this.getSigmaFromOpportunity(b);
      return sigmaB - sigmaA;
    });

    logger.debug(`[CertaintyArbitrage] Found ${opportunities.length} high-certainty opportunities`);
    return opportunities;
  }

  /**
   * Analyze a single market for certainty arbitrage
   */
  private async analyzeMarket(market: ParsedWeatherMarket): Promise<CertaintyOpportunity | null> {
    const opportunity = await this.opportunityDetector.analyzeMarket(market);
    
    if (!opportunity || opportunity.action === 'none') {
      return null;
    }

    // CERTAINTY-ONLY MODE: Only trade guaranteed outcomes
    const sigmaThreshold = config.CERTAINTY_ONLY_MODE 
      ? 3.5  // Only very high certainty in certainty-only mode
      : (config.CERTAINTY_SIGMA_THRESHOLD_BASE || 3.0);
    
    // Check if it's a guaranteed/certain outcome
    if (!opportunity.isGuaranteed && (!opportunity.certaintySigma || opportunity.certaintySigma < sigmaThreshold)) {
      return null;
    }

    const sigma = opportunity.certaintySigma || 0;
    const daysToEvent = this.calculateDaysToEvent(market);
    const maxDays = config.CERTAINTY_DAYS_TO_EVENT_MAX || 3;

    // Skip if too far out (uncertainty increases)
    if (daysToEvent > maxDays) {
      return null;
    }

    // Calculate expected return
    const certainty = this.sigmaToCertainty(sigma);
    const edge = Math.abs(opportunity.edge);
    const expectedReturn = edge * certainty;

    // Only trade if significant edge
    if (expectedReturn < 0.05) {
      return null;
    }

    return {
      market,
      opportunity,
      sigma,
      certainty,
      expectedReturn,
      daysToEvent,
    };
  }

  /**
   * Determine if we should trade this opportunity
   */
  private shouldTrade(certOpp: CertaintyOpportunity): boolean {
    const marketId = certOpp.market.market.id;

    // Check if already captured
    const captured = this.capturedOpportunities.get(marketId);
    if (captured) {
      // Allow re-entry if forecast changed significantly
      const forecastDiff = Math.abs(certOpp.opportunity.forecastValue! - captured.forecastValue);
      if (forecastDiff < 1.0) {
        return false;  // Already captured similar opportunity
      }
    }

    // Check sigma threshold
    const minSigma = config.CERTAINTY_ONLY_MODE ? 3.5 : this.currentSigmaThreshold;
    if (certOpp.sigma < minSigma) {
      return false;
    }

    // Check if market has caught up
    const priceDiff = Math.abs(certOpp.opportunity.marketProbability - certOpp.opportunity.forecastProbability);
    const minEdge = config.CERTAINTY_MIN_EDGE || 0.05;
    if (priceDiff < minEdge) {
      return false;  // Market has already priced it in
    }

    return true;
  }

  /**
   * Mark opportunity as captured
   */
  markCaptured(marketId: string, sigma: number, forecastValue: number): void {
    this.capturedOpportunities.set(marketId, {
      sigma,
      capturedAt: new Date(),
      forecastValue,
    });

    logger.info(`[CertaintyArbitrage] Captured ${marketId}`, {
      sigma: sigma.toFixed(1),
      forecastValue: forecastValue.toFixed(1),
    });
  }

  /**
   * Update strategy based on trade outcome
   */
  updatePerformance(sigma: number, pnl: number): void {
    this.recentTrades.push({ sigma, pnl });
    
    // Keep only last 20 trades
    if (this.recentTrades.length > 20) {
      this.recentTrades.shift();
    }

    // Adjust threshold based on performance
    this.adjustThreshold();
  }

  /**
   * Adaptively adjust sigma threshold
   */
  private adjustThreshold(): void {
    if (this.recentTrades.length < 10) return;

    const wins = this.recentTrades.filter(t => t.pnl > 0).length;
    const winRate = wins / this.recentTrades.length;

    // If winning > 90%, can accept slightly lower certainty
    if (winRate > 0.90 && this.currentSigmaThreshold > 2.5) {
      this.currentSigmaThreshold -= 0.1;
      logger.info(`[CertaintyArbitrage] Lowered sigma threshold to ${this.currentSigmaThreshold.toFixed(1)}`);
    }
    // If winning < 80%, require higher certainty
    else if (winRate < 0.80 && this.currentSigmaThreshold < 4.0) {
      this.currentSigmaThreshold += 0.1;
      logger.info(`[CertaintyArbitrage] Raised sigma threshold to ${this.currentSigmaThreshold.toFixed(1)}`);
    }
  }

  /**
   * Convert sigma to certainty percentage
   */
  private sigmaToCertainty(sigma: number): number {
    // 1σ = 68%, 2σ = 95%, 3σ = 99.7%, 4σ = 99.99%
    if (sigma >= 4.0) return 0.9999;
    if (sigma >= 3.5) return 0.999;
    if (sigma >= 3.0) return 0.997;
    if (sigma >= 2.5) return 0.99;
    if (sigma >= 2.0) return 0.95;
    if (sigma >= 1.5) return 0.87;
    return 0.68;
  }

  /**
   * Calculate days to event
   */
  private calculateDaysToEvent(market: ParsedWeatherMarket): number {
    if (!market.targetDate) return 0;
    const diff = market.targetDate.getTime() - Date.now();
    return Math.max(0, diff / (1000 * 60 * 60 * 24));
  }

  /**
   * Extract sigma from opportunity (stored in reason or certaintySigma)
   */
  private getSigmaFromOpportunity(opp: TradingOpportunity): number {
    return opp.certaintySigma || 0;
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    capturedCount: number;
    currentThreshold: number;
    recentTrades: number;
    recentWinRate: number;
  } {
    const wins = this.recentTrades.filter(t => t.pnl > 0).length;
    return {
      capturedCount: this.capturedOpportunities.size,
      currentThreshold: this.currentSigmaThreshold,
      recentTrades: this.recentTrades.length,
      recentWinRate: this.recentTrades.length > 0 ? wins / this.recentTrades.length : 0,
    };
  }

  /**
   * Reset strategy state
   */
  reset(): void {
    this.capturedOpportunities.clear();
    this.recentTrades = [];
    this.currentSigmaThreshold = 3.0;
  }
}

export default CertaintyArbitrageStrategy;
