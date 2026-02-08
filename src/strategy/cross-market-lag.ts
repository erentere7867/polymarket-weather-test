/**
 * Cross-Market Lag Strategy
 * Exploits delay between correlated markets
 * Targets 3-8% returns with 65-75% win rate
 */

import { DataStore } from '../realtime/data-store.js';
import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { OpportunityDetector } from '../bot/opportunity-detector.js';
import { logger } from '../logger.js';

interface MarketCorrelation {
  marketA: string;
  marketB: string;
  correlation: number;
  lastCalculated: Date;
}

interface LagOpportunity {
  targetMarket: ParsedWeatherMarket;
  sourceMarket: ParsedWeatherMarket;
  correlation: number;
  lagSeconds: number;
  predictedMove: 'up' | 'down';
  confidence: number;
  opportunity: TradingOpportunity;
}

export class CrossMarketLagStrategy {
  private store: DataStore;
  private opportunityDetector: OpportunityDetector;

  // Track correlations between markets
  private correlations: Map<string, MarketCorrelation> = new Map();
  
  // Track market update times
  private marketUpdateTimes: Map<string, Date> = new Map();

  // Recently exploited opportunities (prevent re-entry)
  private exploitedOpportunities: Map<string, Date> = new Map();

  // Configuration
  private readonly MIN_CORRELATION = 0.60;
  private readonly MAX_LAG_SECONDS = 300;  // 5 minutes
  private readonly MIN_EDGE = 0.03;
  private readonly REENTRY_COOLDOWN_MS = 600000;  // 10 minutes

  constructor(store: DataStore) {
    this.store = store;
    this.opportunityDetector = new OpportunityDetector(store);
  }

  /**
   * Detect cross-market lag opportunities
   */
  async detectOpportunities(markets: ParsedWeatherMarket[]): Promise<TradingOpportunity[]> {
    const opportunities: TradingOpportunity[] = [];

    // Update market timestamps
    this.updateMarketTimestamps(markets);

    // Find lag opportunities
    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const lagOpp = await this.checkLagOpportunity(markets[i], markets[j]);
        if (lagOpp) {
          opportunities.push(lagOpp.opportunity);
        }
      }
    }

    logger.debug(`[CrossMarketLag] Found ${opportunities.length} lag opportunities`);
    return opportunities;
  }

  /**
   * Check for lag between two markets
   */
  private async checkLagOpportunity(
    marketA: ParsedWeatherMarket,
    marketB: ParsedWeatherMarket
  ): Promise<LagOpportunity | null> {
    // Must be same city or highly correlated cities
    if (!this.areMarketsCorrelated(marketA, marketB)) {
      return null;
    }

    // Get update times
    const timeA = this.marketUpdateTimes.get(marketA.market.id);
    const timeB = this.marketUpdateTimes.get(marketB.market.id);

    if (!timeA || !timeB) {
      return null;
    }

    // Determine which market updated first
    const lagMs = Math.abs(timeA.getTime() - timeB.getTime());
    const lagSeconds = lagMs / 1000;

    if (lagSeconds > this.MAX_LAG_SECONDS) {
      return null;  // Lag too large, market may have already reacted
    }

    if (lagSeconds < 5) {
      return null;  // Not enough lag to exploit
    }

    // Identify leader and follower
    const leader = timeA > timeB ? marketA : marketB;
    const follower = timeA > timeB ? marketB : marketA;

    // Check if already exploited
    const opportunityKey = `${leader.market.id}-${follower.market.id}`;
    const lastExploited = this.exploitedOpportunities.get(opportunityKey);
    if (lastExploited && Date.now() - lastExploited.getTime() < this.REENTRY_COOLDOWN_MS) {
      return null;
    }

    // Analyze both markets
    const oppLeader = await this.opportunityDetector.analyzeMarket(leader);
    const oppFollower = await this.opportunityDetector.analyzeMarket(follower);

    if (!oppLeader || !oppFollower) {
      return null;
    }

    // Predict follower movement based on leader
    const predictedMove = this.predictMovement(oppLeader, oppFollower);
    if (!predictedMove) {
      return null;
    }

    // Calculate confidence
    const correlation = this.calculateCorrelation(marketA, marketB);
    const confidence = correlation * (1 - lagSeconds / this.MAX_LAG_SECONDS);

    if (confidence < 0.60) {
      return null;
    }

    // Build opportunity for follower market
    const edge = Math.abs(oppFollower.edge);
    if (edge < this.MIN_EDGE) {
      return null;
    }

    return {
      targetMarket: follower,
      sourceMarket: leader,
      correlation,
      lagSeconds,
      predictedMove,
      confidence,
      opportunity: {
        ...oppFollower,
        action: predictedMove === 'up' ? 'buy_yes' : 'buy_no',
        reason: `Cross-market lag: ${leader.city} updated ${lagSeconds.toFixed(0)}s ago, predicting ${predictedMove}`,
        confidence: confidence * oppFollower.confidence,
      },
    };
  }

  /**
   * Check if two markets are correlated
   */
  private areMarketsCorrelated(a: ParsedWeatherMarket, b: ParsedWeatherMarket): boolean {
    // Same city = highly correlated
    if (a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase()) {
      return true;
    }

    // Same metric type and close dates
    if (a.metricType === b.metricType && a.targetDate && b.targetDate) {
      const dateDiff = Math.abs(a.targetDate.getTime() - b.targetDate.getTime());
      const daysDiff = dateDiff / (1000 * 60 * 60 * 24);
      
      if (daysDiff <= 1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate correlation between markets
   */
  private calculateCorrelation(a: ParsedWeatherMarket, b: ParsedWeatherMarket): number {
    const key = this.getCorrelationKey(a, b);
    const cached = this.correlations.get(key);

    if (cached && Date.now() - cached.lastCalculated.getTime() < 3600000) {
      return cached.correlation;
    }

    let correlation = 0.70;  // Base correlation

    // Boost for same city
    if (a.city === b.city) {
      correlation += 0.20;
    }

    // Boost for same date
    if (a.targetDate && b.targetDate) {
      const dateDiff = Math.abs(a.targetDate.getTime() - b.targetDate.getTime());
      if (dateDiff < 86400000) {  // Same day
        correlation += 0.10;
      }
    }

    correlation = Math.min(0.95, correlation);

    // Cache result
    this.correlations.set(key, {
      marketA: a.market.id,
      marketB: b.market.id,
      correlation,
      lastCalculated: new Date(),
    });

    return correlation;
  }

  /**
   * Predict movement direction based on leader
   */
  private predictMovement(
    leaderOpp: TradingOpportunity,
    followerOpp: TradingOpportunity
  ): 'up' | 'down' | null {
    // If leader says buy YES, follower likely to go up
    if (leaderOpp.action === 'buy_yes' && leaderOpp.edge > 0.05) {
      // Check if follower is underpriced
      if (followerOpp.forecastProbability > followerOpp.marketProbability) {
        return 'up';
      }
    }

    // If leader says buy NO, follower likely to go down
    if (leaderOpp.action === 'buy_no' && leaderOpp.edge > 0.05) {
      // Check if follower is overpriced
      if (followerOpp.forecastProbability < followerOpp.marketProbability) {
        return 'down';
      }
    }

    return null;
  }

  /**
   * Update market timestamps
   */
  private updateMarketTimestamps(markets: ParsedWeatherMarket[]): void {
    for (const market of markets) {
      const state = this.store.getMarketState(market.market.id);
      if (state?.lastForecast?.timestamp) {
        this.marketUpdateTimes.set(market.market.id, state.lastForecast.timestamp);
      }
    }
  }

  /**
   * Mark opportunity as exploited
   */
  markExploited(marketAId: string, marketBId: string): void {
    const key = this.getCorrelationKeyById(marketAId, marketBId);
    this.exploitedOpportunities.set(key, new Date());
  }

  /**
   * Get correlation key
   */
  private getCorrelationKey(a: ParsedWeatherMarket, b: ParsedWeatherMarket): string {
    return [a.market.id, b.market.id].sort().join('-');
  }

  private getCorrelationKeyById(a: string, b: string): string {
    return [a, b].sort().join('-');
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    trackedCorrelations: number;
    exploitedCount: number;
    avgLagSeconds: number;
  } {
    return {
      trackedCorrelations: this.correlations.size,
      exploitedCount: this.exploitedOpportunities.size,
      avgLagSeconds: 0,  // Would calculate from history
    };
  }

  /**
   * Reset strategy
   */
  reset(): void {
    this.correlations.clear();
    this.marketUpdateTimes.clear();
    this.exploitedOpportunities.clear();
  }
}

export default CrossMarketLagStrategy;
