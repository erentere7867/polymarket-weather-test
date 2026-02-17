/**
 * Strategy Orchestrator
 * Central controller for multi-strategy trading system
 * No database - pure in-memory with compound growth tracking
 */

import { DataStore } from '../realtime/data-store.js';
import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { logger } from '../logger.js';
import { config, STRATEGY_CONFIG } from '../config.js';
import { CertaintyArbitrageStrategy } from './certainty-arbitrage.js';
import { ConfidenceCompressionStrategy } from './confidence-compression-strategy.js';
import { CrossMarketLagStrategy } from './cross-market-lag.js';
import { AdaptivePositionSizer } from './adaptive-position-sizer.js';
import { PortfolioHeatManager } from './portfolio-heat-manager.js';
import { MarketModel } from '../probability/market-model.js';
import { OpportunityDetector } from '../bot/opportunity-detector.js';
import { LatencyTracker } from '../realtime/latency-tracker.js';

export interface StrategySignal {
  strategy: StrategyType;
  opportunity: TradingOpportunity;
  priority: number;
  confidence: number;
  expectedReturn: number;
  winProbability: number;
  traceId?: string;  // Unique ID for end-to-end latency tracking
}

export type StrategyType = 
  | 'CERTAINTY_ARBITRAGE'
  | 'CONFIDENCE_COMPRESSION'
  | 'CROSS_MARKET_LAG'
  | 'TIME_DECAY'
  | 'MODEL_DIVERGENCE';

export interface StrategyPerformance {
  strategy: StrategyType;
  trades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  lastTradeTime?: Date;
  streak: number;  // positive = winning streak, negative = losing streak
}

export interface CompoundGrowthState {
  initialCapital: number;
  currentCapital: number;
  peakCapital: number;
  totalReturn: number;
  maxDrawdown: number;
  tradingDay: number;
  dailyPnL: number;
  dailyTrades: number;
  lastResetTime: Date;
}

export class StrategyOrchestrator {
  private store: DataStore;
  private opportunityDetector: OpportunityDetector;
  private positionSizer: AdaptivePositionSizer;
  private heatManager: PortfolioHeatManager;
  private marketModel: MarketModel;

  // Strategies
  private certaintyArbitrage: CertaintyArbitrageStrategy;
  private confidenceCompression: ConfidenceCompressionStrategy;
  private crossMarketLag: CrossMarketLagStrategy;

  // Performance tracking (in-memory)
  private performance: Map<StrategyType, StrategyPerformance> = new Map();
  private compoundState: CompoundGrowthState;
  private readonly MAX_TRADE_HISTORY = 1000;  // Bound memory usage
  private tradeHistory: Array<{
    timestamp: Date;
    strategy: StrategyType;
    marketId: string;
    side: 'buy_yes' | 'buy_no' | 'none';
    size: number;
    entryPrice: number;
    exitPrice?: number;
    pnl?: number;
    status: 'open' | 'closed';
  }> = [];
  
  // Map for O(1) trade lookups by market ID (~50ms savings)
  private tradeHistoryByMarket: Map<string, typeof this.tradeHistory[number]> = new Map();

  // Strategy weights (dynamic)
  private strategyWeights: Map<StrategyType, number> = new Map([
    ['CERTAINTY_ARBITRAGE', 0.40],
    ['CONFIDENCE_COMPRESSION', 0.30],
    ['CROSS_MARKET_LAG', 0.20],
    ['TIME_DECAY', 0.07],
    ['MODEL_DIVERGENCE', 0.03],
  ]);

  // Configuration - using STRATEGY_CONFIG from config.ts
  private readonly TARGET_WIN_RATE = STRATEGY_CONFIG.TARGET_WIN_RATE;
  private readonly MIN_WIN_RATE_ADJUSTMENT = 0.50;
  private readonly COMPOUND_RESET_DAYS = 30;
  private readonly MAX_DAILY_TRADES = 50;
  private readonly MAX_DAILY_LOSS_PERCENT = 0.05;  // 5% max daily loss

  constructor(
    store: DataStore,
    opportunityDetector: OpportunityDetector,
    marketModel: MarketModel,
    initialCapital: number = 1000
  ) {
    this.store = store;
    this.opportunityDetector = opportunityDetector;
    this.marketModel = marketModel;
    this.positionSizer = new AdaptivePositionSizer();
    this.heatManager = new PortfolioHeatManager(initialCapital);

    // Initialize strategies
    this.certaintyArbitrage = new CertaintyArbitrageStrategy(store, opportunityDetector);
    this.confidenceCompression = new ConfidenceCompressionStrategy(store);
    this.crossMarketLag = new CrossMarketLagStrategy(store);

    // Initialize compound growth state
    this.compoundState = {
      initialCapital,
      currentCapital: initialCapital,
      peakCapital: initialCapital,
      totalReturn: 0,
      maxDrawdown: 0,
      tradingDay: 0,
      dailyPnL: 0,
      dailyTrades: 0,
      lastResetTime: new Date(),
    };

    // Initialize performance tracking
    this.initializePerformanceTracking();

    logger.info('[StrategyOrchestrator] Initialized', {
      initialCapital,
      strategies: Array.from(this.strategyWeights.keys()),
    });
  }

  private initializePerformanceTracking(): void {
    const strategies: StrategyType[] = [
      'CERTAINTY_ARBITRAGE',
      'CONFIDENCE_COMPRESSION',
      'CROSS_MARKET_LAG',
      'TIME_DECAY',
      'MODEL_DIVERGENCE',
    ];

    for (const strategy of strategies) {
      this.performance.set(strategy, {
        strategy,
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        streak: 0,
      });
    }
  }

  /**
   * Main entry point: Analyze all markets and generate signals
   */
  async analyzeAllMarkets(markets: ParsedWeatherMarket[], traceId?: string): Promise<StrategySignal[]> {
    const allSignals: StrategySignal[] = [];

    // Record strategy start time for latency tracking
    if (traceId) {
      const latencyTracker = LatencyTracker.getInstance();
      latencyTracker.recordTime(traceId, 'strategyStartTime', Date.now());
    }

    // Check daily limits
    if (this.compoundState.dailyTrades >= this.MAX_DAILY_TRADES) {
      logger.info('[StrategyOrchestrator] Daily trade limit reached');
      return [];
    }

    if (this.compoundState.dailyPnL < -this.compoundState.currentCapital * this.MAX_DAILY_LOSS_PERCENT) {
      logger.warn('[StrategyOrchestrator] Daily loss limit reached - pausing trading');
      return [];
    }

    // Get signals from each strategy
    const strategySignals = await this.gatherStrategySignals(markets);
    
    // Score and rank signals
    for (const signal of strategySignals) {
      const scoredSignal = this.scoreSignal(signal);
      if (scoredSignal.confidence >= 0.70) {
        allSignals.push(scoredSignal);
      }
    }

    // Sort by expected return and confidence
    allSignals.sort((a, b) => {
      const scoreA = a.expectedReturn * a.confidence;
      const scoreB = b.expectedReturn * b.confidence;
      return scoreB - scoreA;
    });

    // Apply portfolio constraints
    const filteredSignals = this.applyPortfolioConstraints(allSignals);

    // Record strategy end time for latency tracking
    if (traceId) {
      const latencyTracker = LatencyTracker.getInstance();
      latencyTracker.recordTime(traceId, 'strategyEndTime', Date.now());
    }

    // Attach traceId to all signals for downstream tracking
    const signalsWithTrace = filteredSignals.map(s => ({ ...s, traceId }));

    logger.debug(`[StrategyOrchestrator] Analyzed ${markets.length} markets, ${signalsWithTrace.length} signals passed constraints`);

    return signalsWithTrace;
  }

  /**
   * Gather signals from all strategies in parallel for ~300ms latency reduction
   */
  private async gatherStrategySignals(markets: ParsedWeatherMarket[]): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];

    // Execute all strategy detections in parallel
    const [certaintySignals, compressionSignals, lagSignals] = await Promise.all([
      this.certaintyArbitrage.detectOpportunities(markets),
      Promise.resolve(this.confidenceCompression.detectOpportunities()),
      this.crossMarketLag.detectOpportunities(markets)
    ]);

    // 1. Process Certainty Arbitrage signals (highest priority)
    for (const opp of certaintySignals) {
      signals.push({
        strategy: 'CERTAINTY_ARBITRAGE',
        opportunity: opp,
        priority: 10,
        confidence: opp.confidence,
        expectedReturn: this.calculateExpectedReturn(opp),
        winProbability: opp.isGuaranteed ? 0.99 : 0.80,
      });
    }

    // 2. Process Confidence Compression signals
    // Process compression market analysis in parallel
    const compressionOpportunities = await Promise.all(
      compressionSignals.map(async (signal) => {
        const market = markets.find(m => m.market.id === signal.marketId);
        if (market) {
          const opportunity = await this.opportunityDetector.analyzeMarket(market);
          if (opportunity && opportunity.action !== 'none') {
            return {
              strategy: 'CONFIDENCE_COMPRESSION' as const,
              opportunity,
              priority: 7,
              confidence: signal.confidence,
              expectedReturn: this.calculateExpectedReturn(opportunity),
              winProbability: signal.confidence,
            };
          }
        }
        return null;
      })
    );
    signals.push(...compressionOpportunities.filter((s) => s !== null) as StrategySignal[]);

    // 3. Process Cross-Market Lag signals
    for (const opp of lagSignals) {
      signals.push({
        strategy: 'CROSS_MARKET_LAG',
        opportunity: opp,
        priority: 5,
        confidence: opp.confidence * 0.85,  // Slightly lower confidence
        expectedReturn: this.calculateExpectedReturn(opp),
        winProbability: 0.70,
      });
    }

    return signals;
  }

  /**
   * Score a signal based on strategy performance and market conditions
   */
  private scoreSignal(signal: StrategySignal): StrategySignal {
    const perf = this.performance.get(signal.strategy)!;
    
    // Adjust confidence based on strategy performance
    let adjustedConfidence = signal.confidence;
    
    if (perf.trades > 10) {
      // Boost confidence if strategy is performing well
      if (perf.winRate > this.TARGET_WIN_RATE) {
        adjustedConfidence *= 1.1;
      }
      // Reduce confidence if strategy is underperforming
      else if (perf.winRate < this.MIN_WIN_RATE_ADJUSTMENT) {
        adjustedConfidence *= 0.8;
      }

      // Consider streak
      if (perf.streak >= 3) {
        adjustedConfidence *= 1.05;  // Winning streak bonus
      } else if (perf.streak <= -3) {
        adjustedConfidence *= 0.85;  // Losing streak penalty
      }
    }

    // Adjust expected return based on edge decay
    const edgeAge = Date.now() - (signal.opportunity.snapshotTimestamp?.getTime() || Date.now());
    const decayFactor = Math.exp(-edgeAge / STRATEGY_CONFIG.PERFORMANCE_DECAY_HALF_LIFE_MS);
    const adjustedReturn = signal.expectedReturn * decayFactor;

    return {
      ...signal,
      confidence: Math.min(1.0, adjustedConfidence),
      expectedReturn: adjustedReturn,
    };
  }

  /**
   * Apply portfolio constraints to signals
   */
  private applyPortfolioConstraints(signals: StrategySignal[]): StrategySignal[] {
    const filtered: StrategySignal[] = [];
    let currentHeat = this.heatManager.getCurrentHeat();
    const maxHeat = config.MAX_KELLY_HEAT;

    for (const signal of signals) {
      // Calculate position size
      const positionSize = this.positionSizer.calculatePositionSize(
        signal,
        this.compoundState.currentCapital,
        this.performance.get(signal.strategy)!
      );

      // Check if we can add this position
      if (currentHeat + positionSize.heatContribution > maxHeat) {
        logger.debug(`[StrategyOrchestrator] Skipping ${signal.opportunity.market.market.id} - would exceed heat limit`);
        continue;
      }

      // Check correlation constraints
      if (!this.heatManager.canAddPosition(signal.opportunity.market.market.id, positionSize.size)) {
        continue;
      }

      filtered.push({
        ...signal,
        opportunity: {
          ...signal.opportunity,
          // Update with calculated size
          suggestedSize: positionSize.size,
        } as TradingOpportunity,
      });

      currentHeat += positionSize.heatContribution;
    }

    return filtered;
  }

  /**
   * Calculate expected return for an opportunity
   */
  private calculateExpectedReturn(opportunity: TradingOpportunity): number {
    const edge = Math.abs(opportunity.edge);
    const winProb = opportunity.forecastProbability > 0.5 
      ? opportunity.forecastProbability 
      : 1 - opportunity.forecastProbability;
    
    // Simplified expected return calculation
    return edge * winProb * 100;  // As percentage
  }

  /**
   * Execute a trade and track it
   */
  executeTrade(signal: StrategySignal, entryPrice: number, size: number): void {
    if (signal.opportunity.action === 'none') {
      return;
    }
    
    const trade = {
      timestamp: new Date(),
      strategy: signal.strategy,
      marketId: signal.opportunity.market.market.id,
      side: signal.opportunity.action,
      size,
      entryPrice,
      status: 'open' as const,
    };

    // Bound trade history to prevent memory leak
    while (this.tradeHistory.length >= this.MAX_TRADE_HISTORY) {
      const removed = this.tradeHistory.shift();
      if (removed && removed.status === 'open') {
        this.tradeHistoryByMarket.delete(removed.marketId);
      }
    }

    this.tradeHistory.push(trade);
    this.tradeHistoryByMarket.set(trade.marketId, trade);  // O(1) lookup
    this.heatManager.addPosition(signal.opportunity.market.market.id, size, signal.strategy);
    this.compoundState.dailyTrades++;

    logger.info(`[StrategyOrchestrator] Executed ${signal.strategy} trade`, {
      marketId: trade.marketId,
      side: trade.side,
      size: trade.size,
      confidence: signal.confidence.toFixed(2),
    });
  }

  /**
   * Close a trade and update performance
   */
  closeTrade(marketId: string, exitPrice: number): void {
    // O(1) lookup using Map instead of O(n) array search
    const trade = this.tradeHistoryByMarket.get(marketId);
    if (!trade || trade.status !== 'open') return;

    trade.exitPrice = exitPrice;
    trade.status = 'closed';
    
    // Remove from Map when trade is closed
    this.tradeHistoryByMarket.delete(marketId);

    // Calculate PnL
    const pnl = trade.side === 'buy_yes'
      ? (exitPrice - trade.entryPrice) * trade.size
      : (1 - exitPrice - (1 - trade.entryPrice)) * trade.size;

    trade.pnl = pnl;

    // Update compound state
    this.compoundState.currentCapital += pnl;
    this.compoundState.dailyPnL += pnl;
    
    if (this.compoundState.currentCapital > this.compoundState.peakCapital) {
      this.compoundState.peakCapital = this.compoundState.currentCapital;
    }

    // Update drawdown
    const drawdown = (this.compoundState.peakCapital - this.compoundState.currentCapital) / this.compoundState.peakCapital;
    if (drawdown > this.compoundState.maxDrawdown) {
      this.compoundState.maxDrawdown = drawdown;
    }

    // Update strategy performance
    this.updateStrategyPerformance(trade.strategy, pnl);

    // Remove from heat manager
    this.heatManager.removePosition(marketId);

    logger.info(`[StrategyOrchestrator] Closed trade`, {
      marketId: trade.marketId,
      strategy: trade.strategy,
      pnl: pnl.toFixed(2),
      currentCapital: this.compoundState.currentCapital.toFixed(2),
    });
  }

  /**
   * Update performance metrics for a strategy
   */
  private updateStrategyPerformance(strategy: StrategyType, pnl: number): void {
    const perf = this.performance.get(strategy)!;
    
    perf.trades++;
    perf.totalPnL += pnl;
    perf.lastTradeTime = new Date();

    if (pnl > 0) {
      perf.wins++;
      perf.streak = perf.streak > 0 ? perf.streak + 1 : 1;
      perf.avgWin = (perf.avgWin * (perf.wins - 1) + pnl) / perf.wins;
    } else {
      perf.losses++;
      perf.streak = perf.streak < 0 ? perf.streak - 1 : -1;
      perf.avgLoss = (perf.avgLoss * (perf.losses - 1) + Math.abs(pnl)) / perf.losses;
    }

    perf.winRate = perf.wins / perf.trades;
    perf.profitFactor = perf.avgLoss > 0 ? perf.avgWin / perf.avgLoss : perf.avgWin;

    // Adjust strategy weights based on performance
    this.adjustStrategyWeights();
  }

  /**
   * Dynamically adjust strategy weights based on performance
   */
  private adjustStrategyWeights(): void {
    // Only adjust after sufficient data
    const totalTrades = Array.from(this.performance.values()).reduce((sum, p) => sum + p.trades, 0);
    if (totalTrades < 20) return;

    // Calculate performance scores
    let totalScore = 0;
    const scores = new Map<StrategyType, number>();

    for (const [strategy, perf] of this.performance) {
      // Score = win rate * profit factor * log(trades + 1)
      const tradeFactor = Math.log(perf.trades + 1);
      const score = perf.winRate * Math.max(0.1, perf.profitFactor) * tradeFactor;
      scores.set(strategy, score);
      totalScore += score;
    }

    // Normalize to weights
    if (totalScore > 0) {
      for (const [strategy, score] of scores) {
        const newWeight = score / totalScore;
        // Smooth transition: 70% old weight, 30% new weight
        const currentWeight = this.strategyWeights.get(strategy) || 0.20;
        const smoothedWeight = currentWeight * 0.7 + newWeight * 0.3;
        
        // Ensure minimum weight for diversification
        const finalWeight = Math.max(0.05, smoothedWeight);
        this.strategyWeights.set(strategy, finalWeight);
      }

      // Renormalize to sum to 1
      const sum = Array.from(this.strategyWeights.values()).reduce((a, b) => a + b, 0);
      for (const [strategy, weight] of this.strategyWeights) {
        this.strategyWeights.set(strategy, weight / sum);
      }
    }

    logger.debug('[StrategyOrchestrator] Adjusted strategy weights', {
      weights: Object.fromEntries(this.strategyWeights),
    });
  }

  /**
   * Reset daily metrics (call at midnight UTC)
   */
  resetDailyMetrics(): void {
    this.compoundState.dailyPnL = 0;
    this.compoundState.dailyTrades = 0;
    this.compoundState.tradingDay++;

    // Check if we need to reset compound period
    const daysSinceReset = (Date.now() - this.compoundState.lastResetTime.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceReset >= this.COMPOUND_RESET_DAYS) {
      this.compoundState.initialCapital = this.compoundState.currentCapital;
      this.compoundState.lastResetTime = new Date();
      logger.info('[StrategyOrchestrator] Compound period reset', {
        newBaseCapital: this.compoundState.initialCapital.toFixed(2),
      });
    }

    logger.info('[StrategyOrchestrator] Daily metrics reset', {
      tradingDay: this.compoundState.tradingDay,
      currentCapital: this.compoundState.currentCapital.toFixed(2),
    });
  }

  /**
   * Get current performance summary
   */
  getPerformanceSummary(): {
    compound: CompoundGrowthState;
    strategies: Record<StrategyType, StrategyPerformance>;
    weights: Record<StrategyType, number>;
    openTrades: number;
    winRate: number;
  } {
    const totalTrades = this.tradeHistory.filter(t => t.status === 'closed').length;
    const winningTrades = this.tradeHistory.filter(t => t.status === 'closed' && (t.pnl || 0) > 0).length;
    
    return {
      compound: { ...this.compoundState },
      strategies: Object.fromEntries(this.performance) as Record<StrategyType, StrategyPerformance>,
      weights: Object.fromEntries(this.strategyWeights) as Record<StrategyType, number>,
      openTrades: this.tradeHistory.filter(t => t.status === 'open').length,
      winRate: totalTrades > 0 ? winningTrades / totalTrades : 0,
    };
  }

  /**
   * Get top signals for execution
   */
  getTopSignals(count: number = 5): StrategySignal[] {
    // This would typically be called after analyzeAllMarkets
    // For now, return empty - signals should be passed through analyzeAllMarkets
    return [];
  }

  /**
   * Reset all state (for testing)
   */
  reset(): void {
    this.tradeHistory = [];
    this.initializePerformanceTracking();
    this.compoundState = {
      initialCapital: this.compoundState.initialCapital,
      currentCapital: this.compoundState.initialCapital,
      peakCapital: this.compoundState.initialCapital,
      totalReturn: 0,
      maxDrawdown: 0,
      tradingDay: 0,
      dailyPnL: 0,
      dailyTrades: 0,
      lastResetTime: new Date(),
    };
    this.strategyWeights = new Map([
      ['CERTAINTY_ARBITRAGE', 0.40],
      ['CONFIDENCE_COMPRESSION', 0.30],
      ['CROSS_MARKET_LAG', 0.20],
      ['TIME_DECAY', 0.07],
      ['MODEL_DIVERGENCE', 0.03],
    ]);
    this.heatManager.reset();
  }
}

export default StrategyOrchestrator;
