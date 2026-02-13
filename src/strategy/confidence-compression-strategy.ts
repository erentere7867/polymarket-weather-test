/**
 * Confidence Compression Strategy (Safe Mode)
 * Conservative trading with high confidence requirements
 * Only trades when models agree and stability is confirmed
 */

import { DataStore } from '../realtime/data-store.js';
import { EntrySignal } from './entry-optimizer.js';
import { RunHistoryStore, RunRecord } from './run-history-store.js';
import { RunStabilityAnalyzer } from './run-stability-analyzer.js';
import { ConfidenceScorer, ConfidenceResult } from './confidence-scorer.js';
import { ModelHierarchy } from './model-hierarchy.js';
import { ModelType } from '../weather/types.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { normalCDF } from '../probability/normal-cdf.js';
import { logger, rateLimitedLogger } from '../logger.js';
import { config } from '../config.js';

type BlockReason =
    | 'FIRST_RUN'
    | 'NOT_PRIMARY_MODEL'
    | 'STABILITY_CHECK_FAILED'
    | 'CONFIDENCE_BELOW_THRESHOLD'
    | 'EDGE_TOO_SMALL'
    | 'OPPORTUNITY_ALREADY_CAPTURED'
    | 'UNCONFIRMED_EXTREME_CHANGE';

interface OpportunityAnalysis {
    marketId: string;
    blocked: boolean;
    blockReason?: BlockReason;
    signal?: EntrySignal;
    marketProbability?: number;
    modelProbability?: number;
    rawEdge?: number;
    confidenceScore?: number;
    targetDate?: string;
}

interface CapturedOpportunity {
    marketId: string;
    forecastValue: number;
    capturedAt: Date;
}

export class ConfidenceCompressionStrategy {
    private store: DataStore;
    private runHistoryStore: RunHistoryStore;
    private stabilityAnalyzer: RunStabilityAnalyzer;
    private confidenceScorer: ConfidenceScorer;
    private modelHierarchy: ModelHierarchy;

    private capturedOpportunities: Map<string, CapturedOpportunity> = new Map();
    private analysisCache: Map<string, {
        primaryTimestamp: number;
        blockReason?: BlockReason;
        confidenceResult: ConfidenceResult;
    }> = new Map();

    private readonly CONFIDENCE_THRESHOLD = 0.7;
    private readonly STABILITY_THRESHOLD = 0.6;
    private readonly TRANSACTION_COST = 0.01;
    private readonly UNCERTAINTY_BUFFER = {
        temperature: 0.02,
        precipitation: 0.05,
    };

    constructor(store: DataStore) {
        this.store = store;
        this.runHistoryStore = new RunHistoryStore(5);
        this.modelHierarchy = new ModelHierarchy();
        this.stabilityAnalyzer = new RunStabilityAnalyzer(this.runHistoryStore);
        this.confidenceScorer = new ConfidenceScorer(
            this.runHistoryStore,
            this.stabilityAnalyzer,
            this.modelHierarchy
        );
    }

    /**
     * Process a new model run
     */
    processModelRun(
        cityId: string,
        model: ModelType,
        cycleHour: number,
        runDate: Date,
        maxTempC: number,
        precipFlag: boolean,
        precipAmountMm: number = 0,
        source: 'API' | 'FILE' = 'API'
    ): void {
        const record: RunRecord = {
            model,
            cycleHour,
            runDate,
            cityId,
            maxTempC,
            precipFlag,
            precipAmountMm,
            timestamp: new Date(),
            source,
        };

        this.runHistoryStore.addRun(record);
    }

    /**
     * Mark opportunity as captured
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, { marketId, forecastValue, capturedAt: new Date() });
    }

    /**
     * Check if opportunity is already captured
     */
    private isOpportunityCaptured(marketId: string, currentForecastValue: number): boolean {
        const captured = this.capturedOpportunities.get(marketId);
        if (!captured) return false;

        if (Math.abs(currentForecastValue - captured.forecastValue) > 0.5) {
            this.capturedOpportunities.delete(marketId);
            return false;
        }

        return true;
    }

    /**
     * Analyze a single market
     */
    private analyzeMarket(market: ParsedWeatherMarket): OpportunityAnalysis {
        const cityId = market.city?.toLowerCase() || 'unknown';
        const marketType = market.metricType === 'precipitation' ? 'precipitation' : 'temperature';
        const model = this.modelHierarchy.getPrimaryModel(cityId);

        const analysis: OpportunityAnalysis = {
            marketId: market.market.id,
            blocked: true,
        };

        // Cache key for expensive calculations
        const cacheKey = `${cityId}:${model}:${marketType}`;
        const primaryRun = this.runHistoryStore.getLatestRun(cityId, model);
        const cached = this.analysisCache.get(cacheKey);
        
        const primaryTs = primaryRun ? primaryRun.timestamp.getTime() : 0;
        const isCacheValid = cached && cached.primaryTimestamp === primaryTs;

        let confidenceResult: ConfidenceResult;
        let blockReason: BlockReason | undefined;

        if (isCacheValid) {
            confidenceResult = cached.confidenceResult;
            blockReason = cached.blockReason;
        } else {
            confidenceResult = this.confidenceScorer.evaluate(cityId, model, marketType);
            const stabilityResult = this.stabilityAnalyzer.isMarketStable(cityId, model, marketType);

            // Check requirements
            const isPrimary = this.modelHierarchy.canInitiateTrade(cityId, model);
            if (!isPrimary && confidenceResult.score < 0.85) {
                blockReason = 'NOT_PRIMARY_MODEL';
            } else if (!stabilityResult.isStable && confidenceResult.score < this.STABILITY_THRESHOLD) {
                blockReason = 'STABILITY_CHECK_FAILED';
            } else if (!confidenceResult.meetsThreshold) {
                blockReason = 'CONFIDENCE_BELOW_THRESHOLD';
            }

            // Update cache
            this.analysisCache.set(cacheKey, {
                primaryTimestamp: primaryTs,
                blockReason,
                confidenceResult,
            });
        }

        // Add confidence score to analysis
        analysis.confidenceScore = confidenceResult.score;
        const horizonHours = this.getHorizonHours(market.targetDate);
        if (market.targetDate) {
            analysis.targetDate = market.targetDate.toISOString();
        }

        if (blockReason) {
            analysis.blockReason = blockReason;
            // Try to calculate probabilities for dashboard visibility even if blocked
            try {
                const state = this.store.getMarketState(market.market.id);
                if (state?.lastForecast) {
                    const forecastValue = state.lastForecast.forecastValue;
                    const threshold = market.threshold || 0;
                    const comparisonType = market.comparisonType || 'above';

                    const modelProbability = this.confidenceToProbability(
                        confidenceResult.score,
                        forecastValue,
                        threshold,
                        comparisonType as 'above' | 'below',
                        horizonHours
                    );
                    const marketProbability = market.yesPrice;

                    analysis.modelProbability = modelProbability;
                    analysis.marketProbability = marketProbability;
                    analysis.rawEdge = Math.abs(modelProbability - marketProbability);
                }
            } catch (e) {
                // Ignore errors during speculative calculation
            }
            return analysis;
        }

        // Check run count
        const runCount = this.runHistoryStore.getRunCount(cityId, model);
        if (runCount < 2) {
            analysis.blockReason = 'FIRST_RUN';
            return analysis;
        }

        // Get forecast
        const state = this.store.getMarketState(market.market.id);
        if (!state?.lastForecast) {
            analysis.blockReason = 'EDGE_TOO_SMALL';
            return analysis;
        }

        const forecastValue = state.lastForecast.forecastValue;

        // Check if already captured
        if (this.isOpportunityCaptured(market.market.id, forecastValue)) {
            analysis.blockReason = 'OPPORTUNITY_ALREADY_CAPTURED';
            return analysis;
        }

        // Calculate probability
        let modelProbability: number;
        const threshold = market.threshold || 0;
        const comparisonType = market.comparisonType || 'above';

        modelProbability = this.confidenceToProbability(
            confidenceResult.score,
            forecastValue,
            threshold,
            comparisonType as 'above' | 'below',
            horizonHours
        );

        // Calculate edge
        const marketProbability = market.yesPrice;
        const rawEdge = Math.abs(modelProbability - marketProbability);
        const buffer = this.UNCERTAINTY_BUFFER[marketType];
        const adjustedEdge = rawEdge - this.TRANSACTION_COST - buffer;

        // Populate analysis with probability data
        analysis.modelProbability = modelProbability;
        analysis.marketProbability = marketProbability;
        analysis.rawEdge = rawEdge;

        if (adjustedEdge < config.minEdgeThreshold) {
            analysis.blockReason = 'EDGE_TOO_SMALL';
            return analysis;
        }

        // Determine side
        const side: 'yes' | 'no' = modelProbability > marketProbability ? 'yes' : 'no';

        // Calculate size
        const baseSize = config.maxPositionSize;
        const sizeModifier = confidenceResult.score * (1 + adjustedEdge);
        const size = Math.min(baseSize, Math.floor(baseSize * sizeModifier));

        // Build signal
        analysis.blocked = false;
        analysis.signal = {
            marketId: market.market.id,
            side,
            size,
            orderType: 'MARKET',
            urgency: 'MEDIUM',
            reason: `Safe: ${(confidenceResult.score * 100).toFixed(0)}% conf, ${(adjustedEdge * 100).toFixed(1)}% edge`,
            confidence: confidenceResult.score,
            estimatedEdge: adjustedEdge,
            isGuaranteed: modelProbability > 0.95 || modelProbability < 0.05,
            sigma: confidenceResult.score * 2,  // Approximate sigma from confidence
        };

        logger.info(`Safe mode: ${market.market.id.substring(0, 30)} | ${side.toUpperCase()} ${size} shares`);

        return analysis;
    }

    /**
     * Scan all markets
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const signals: EntrySignal[] = [];

        for (const market of markets) {
            const analysis = this.analyzeMarket(market);
            if (!analysis.blocked && analysis.signal) {
                signals.push(analysis.signal);
            }
        }

        if (signals.length > 0) {
            rateLimitedLogger.info('safe-mode', `Found ${signals.length} safe opportunities`);
        }

        return signals;
    }

    /**
     * Get analysis for all markets (for dashboard)
     */
    getAllMarketAnalysis(): OpportunityAnalysis[] {
        const markets = this.store.getAllMarkets();
        return markets.map(market => this.analyzeMarket(market));
    }

    /**
     * Get horizon hours from target date
     */
    private getHorizonHours(targetDate: Date | undefined): number {
        if (!targetDate) return 48; // Default to 48h if no target date
        const now = new Date();
        const diffMs = targetDate.getTime() - now.getTime();
        return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));
    }

    /**
     * Convert confidence to probability with dynamic sigma based on horizon
     */
    private confidenceToProbability(
        confidence: number,
        forecastValue: number,
        threshold: number,
        comparisonType: 'above' | 'below',
        horizonHours: number
    ): number {
        const distance = forecastValue - threshold;

        // Dynamic sigma based on horizon hours
        let sigma: number;
        if (horizonHours <= 12) {
            sigma = 1.5;
        } else if (horizonHours <= 24) {
            sigma = 2.0;
        } else if (horizonHours <= 48) {
            sigma = 3.0;
        } else {
            sigma = 4.0;
        }

        // Effective sigma scales with confidence (higher confidence = lower sigma needed)
        const effectiveSigma = sigma * (1.2 - confidence * 0.2);

        const zScore = distance / effectiveSigma;
        const baseProbability = normalCDF(zScore);
        const probability = comparisonType === 'above' ? baseProbability : (1 - baseProbability);

        return Math.max(0.01, Math.min(0.99, probability));
    }

    /**
     * Get strategy stats
     */
    getStats(): {
        capturedOpportunities: number;
        runHistory: ReturnType<RunHistoryStore['getStats']>;
        consideredTrades: number;
        blockedTrades: number;
        confirmationBypasses: number;
        blockReasons: Record<BlockReason, number>;
    } {
        const blockReasons: Record<BlockReason, number> = {
            FIRST_RUN: 0,
            NOT_PRIMARY_MODEL: 0,
            STABILITY_CHECK_FAILED: 0,
            CONFIDENCE_BELOW_THRESHOLD: 0,
            EDGE_TOO_SMALL: 0,
            OPPORTUNITY_ALREADY_CAPTURED: 0,
            UNCONFIRMED_EXTREME_CHANGE: 0,
        };
        
        return {
            capturedOpportunities: this.capturedOpportunities.size,
            runHistory: this.runHistoryStore.getStats(),
            consideredTrades: this.capturedOpportunities.size,
            blockedTrades: 0,
            confirmationBypasses: 0,
            blockReasons,
        };
    }

    /**
     * Reset strategy state
     */
    reset(): void {
        this.runHistoryStore.clear();
        this.capturedOpportunities.clear();
        this.analysisCache.clear();
    }
}

export default ConfidenceCompressionStrategy;
