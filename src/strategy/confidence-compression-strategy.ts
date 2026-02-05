/**
 * Confidence Compression Strategy
 * Main trading strategy that trades on forecast uncertainty collapse
 * 
 * CORE PRINCIPLES:
 * 1. Latency is NOT a trading signal - never trade on file arrival
 * 2. Trade on confidence compression - run-to-run stability and model agreement
 * 3. Small edges × many trades - marginal EV per trade, diversify variance
 * 
 * HARD RULES (Non-Negotiable):
 * - NEVER trade on first model run
 * - ONLY primary models initiate trades (HRRR for US, ECMWF for Europe)
 * - Must meet stability criteria before trading
 * - Must meet confidence threshold before trading
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
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Trade blocking reasons for logging/debugging
 */
type BlockReason =
    | 'FIRST_RUN'
    | 'NOT_PRIMARY_MODEL'
    | 'STABILITY_CHECK_FAILED'
    | 'CONFIDENCE_BELOW_THRESHOLD'
    | 'EDGE_TOO_SMALL'
    | 'EDGE_TOO_SMALL'
    | 'EXPOSURE_CAP_REACHED'
    | 'OPPORTUNITY_ALREADY_CAPTURED'
    | 'UNCONFIRMED_EXTREME_CHANGE';

/**
 * Detailed opportunity analysis
 */
interface OpportunityAnalysis {
    marketId: string;
    cityId: string;
    marketType: 'temperature' | 'precipitation';
    model: ModelType;
    blocked: boolean;
    blockReason?: BlockReason;
    confidenceResult?: ConfidenceResult;
    estimatedEdge?: number;
    signal?: EntrySignal;
}

/**
 * Captured opportunity tracking (prevents re-entry)
 */
interface CapturedOpportunity {
    marketId: string;
    forecastValue: number;
    capturedAt: Date;
}

/**
 * Confidence Compression Trading Strategy
 * Replaces SpeedArbitrageStrategy with stability-based approach
 */
export class ConfidenceCompressionStrategy {
    private store: DataStore;
    private runHistoryStore: RunHistoryStore;
    private stabilityAnalyzer: RunStabilityAnalyzer;
    private confidenceScorer: ConfidenceScorer;
    private modelHierarchy: ModelHierarchy;

    // Track all considered and blocked trades for dashboard
    private consideredTrades: number = 0;
    private blockedTrades: number = 0;
    private blockReasons: Map<BlockReason, number> = new Map();
    private confirmationBypasses: number = 0; // Track when secondary model confirms primary

    // Track unique city-model pairs already counted for first run (prevents duplicate counting)
    private firstRunCountedPairs: Set<string> = new Set();

    // Track captured opportunities to prevent re-entry
    private capturedOpportunities: Map<string, CapturedOpportunity> = new Map();

    // Uncertainty buffers for edge calculation
    private uncertaintyBuffer = {
        temperature: 0.02,    // 2% buffer
        precipitation: 0.05,  // 5% buffer (higher uncertainty)
    };

    // Extreme Change Thresholds - Require Secondary Model Confirmation
    private readonly EXTREME_THRESHOLDS = {
        temperature: 8.0,     // 8°F change
        precipitation: 0.5,   // 0.5 in change
    };

    // Confirmation Tolerances - Secondary must be within this range of Primary
    private readonly CONFIRMATION_TOLERANCE = {
        temperature: 4.0,     // 4°F tolerance
        precipitation: 0.25,  // 0.25 in tolerance
    };

    // Transaction cost estimate
    private transactionCost = 0.01; // 1% round-trip

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

        logger.info(`[ConfidenceCompressionStrategy] Initialized with confidence-based trading`);
    }

    /**
     * Process a new model run - add to history store
     * This should be called when new forecast data arrives
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

        // If this pair now has sufficient runs, remove from first run tracking
        const runCount = this.runHistoryStore.getRunCount(cityId, model);
        if (runCount >= 2) {
            const pairKey = `${cityId}:${model}`;
            this.firstRunCountedPairs.delete(pairKey);
        }

        logger.debug(`[ConfidenceCompressionStrategy] Processed run: ${cityId}/${model} ` +
            `temp=${maxTempC.toFixed(1)}°C, precip=${precipFlag}`);
    }

    /**
     * CRITICAL: Check if this is the first run for a city/model
     * HARD RULE: Never trade on first run
     */
    private isFirstRun(cityId: string, model: ModelType): boolean {
        return this.runHistoryStore.isFirstRun(cityId, model);
    }

    /**
     * Mark an opportunity as captured - prevents re-entry until NEW forecast change
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, {
            marketId,
            forecastValue,
            capturedAt: new Date(),
        });
        logger.info(`[ConfidenceCompressionStrategy] Marked opportunity captured: ${marketId}`);
    }

    /**
     * Check if opportunity is already captured
     */
    isOpportunityCaptured(marketId: string, currentForecastValue: number): boolean {
        const captured = this.capturedOpportunities.get(marketId);
        if (!captured) return false;

        // If forecast value changed significantly, opportunity is fresh again
        const significantChange = Math.abs(currentForecastValue - captured.forecastValue) > 0.5;
        if (significantChange) {
            this.capturedOpportunities.delete(marketId);
            return false;
        }

        return true;
    }

    /**
     * Convert confidence score to implied probability
     */
    private confidenceToProbability(
        confidence: number,
        forecastValue: number,
        threshold: number,
        comparisonType: 'above' | 'below'
    ): number {
        // Use normal CDF approximation based on distance from threshold
        const distance = forecastValue - threshold;
        const sigma = 3.0; // Weather forecast uncertainty ~3°F

        const zScore = distance / sigma;
        const baseProbability = normalCDF(zScore);

        // Adjust probability based on comparison type
        const rawProb = comparisonType === 'above' ? baseProbability : (1 - baseProbability);

        // Scale by confidence - higher confidence = closer to extreme
        // At 100% confidence, use raw probability
        // At 60% confidence threshold, be more conservative
        const adjustedProb = 0.5 + (rawProb - 0.5) * confidence;

        return Math.max(0.01, Math.min(0.99, adjustedProb));
    }

    // normalCDF is now imported from '../probability/normal-cdf.js'

    /**
     * Check if a forecast change is "Extreme" and requires cross-model confirmation
     */
    private checkExtremeChange(
        cityId: string,
        primaryModel: ModelType,
        marketType: 'temperature' | 'precipitation',
        currentValue: number
    ): { isExtreme: boolean; change: number; isConfirmed: boolean; secondaryModel?: ModelType; confirmationDiff?: number } {
        // 1. Get previous run to calculate change
        const history = this.runHistoryStore.getLastKRuns(cityId, primaryModel);
        // We need at least 2 runs: current (which might be in history already if processed) and previous
        // Assuming processModelRun is called BEFORE this analysis, the current run is index 0.
        // So we compare index 0 vs index 1.

        if (history.length < 2) {
            return { isExtreme: false, change: 0, isConfirmed: true }; // First run checks handled elsewhere
        }

        const currentRun = history[0];
        const previousRun = history[1]; // The one before current

        // Validate we are looking at the right data (sanity check)
        // If currentRun value doesn't match passed currentValue, we might have a sync issue or using old data
        // For now, assume history[0] is the source of truth if timestamps align, or just use history[1] as baseline.

        let previousValue = 0;
        if (marketType === 'temperature') {
            // Convert C to F for comparison
            previousValue = (previousRun.maxTempC * 9 / 5) + 32;
        } else {
            previousValue = previousRun.precipAmountMm / 25.4; // mm to inches
        }

        const change = Math.abs(currentValue - previousValue);
        let threshold = this.EXTREME_THRESHOLDS[marketType];

        // 1.5x Multiplier for HRRR (American cities) - Take more risk
        // HRRR is high-res and often leads major shifts.
        if (primaryModel === 'HRRR') {
            threshold *= 1.5;
        }

        if (change <= threshold) {
            return { isExtreme: false, change, isConfirmed: true };
        }

        // 2. Change is EXTREME - Require Secondary Confirmation
        const secondary = this.modelHierarchy.getSecondaryModel(cityId);
        if (!secondary) {
            // No secondary model to confirm with? High risk.
            // For safety, BLOCK if no secondary.
            return { isExtreme: true, change, isConfirmed: false };
        }

        const secondaryHistory = this.runHistoryStore.getLastKRuns(cityId, secondary);
        if (secondaryHistory.length === 0) {
            return { isExtreme: true, change, isConfirmed: false, secondaryModel: secondary };
        }

        const latestSecondary = secondaryHistory[0];

        // Check staleness of secondary? (Should be recent)
        // Ignoring staleness for now, assuming detection windows align roughly.

        let secondaryValue = 0;
        if (marketType === 'temperature') {
            secondaryValue = (latestSecondary.maxTempC * 9 / 5) + 32;
        } else {
            secondaryValue = latestSecondary.precipAmountMm / 25.4;
        }

        const diff = Math.abs(currentValue - secondaryValue);
        const tolerance = this.CONFIRMATION_TOLERANCE[marketType];

        return {
            isExtreme: true,
            change,
            isConfirmed: diff <= tolerance,
            secondaryModel: secondary,
            confirmationDiff: diff
        };
    }

    /**
     * Check if secondary model confirms the primary model's forecast
     * This allows bypassing first-run restrictions when we have confirmation
     */
    private checkSecondaryModelConfirmation(
        cityId: string,
        primaryModel: ModelType,
        marketType: 'temperature' | 'precipitation',
        market: ParsedWeatherMarket
    ): { isConfirmed: boolean; secondaryModel?: ModelType; confirmationDiff?: number } {
        // Get secondary model from hierarchy
        const secondary = this.modelHierarchy.getSecondaryModel(cityId);
        if (!secondary) {
            return { isConfirmed: false };
        }

        // Check if secondary model has sufficient history
        const secondaryHistory = this.runHistoryStore.getLastKRuns(cityId, secondary);
        if (secondaryHistory.length < 1) {
            return { isConfirmed: false, secondaryModel: secondary };
        }

        // Get current forecast value from market state
        const state = this.store.getMarketState(market.market.id);
        if (!state?.lastForecast) {
            return { isConfirmed: false, secondaryModel: secondary };
        }
        const primaryValue = state.lastForecast.forecastValue;

        // Get secondary's latest forecast
        const latestSecondary = secondaryHistory[0];
        let secondaryValue: number;
        
        if (marketType === 'temperature') {
            // Convert C to F for comparison
            secondaryValue = (latestSecondary.maxTempC * 9 / 5) + 32;
        } else {
            secondaryValue = latestSecondary.precipAmountMm / 25.4; // mm to inches
        }

        // Check if secondary confirms primary (within tolerance)
        const diff = Math.abs(primaryValue - secondaryValue);
        
        // Use same tolerances as extreme change check
        const tolerance = marketType === 'temperature' ? 4.0 : 0.25;
        
        return {
            isConfirmed: diff <= tolerance,
            secondaryModel: secondary,
            confirmationDiff: diff
        };
    }

    /**
     * Analyze a single market for trading opportunity
     */
    private analyzeMarket(market: ParsedWeatherMarket): OpportunityAnalysis {
        const cityId = market.city?.toLowerCase() || 'unknown';
        const marketType = market.metricType === 'precipitation' ? 'precipitation' : 'temperature';
        const model = this.modelHierarchy.getPrimaryModel(cityId);

        const analysis: OpportunityAnalysis = {
            marketId: market.market.id,
            cityId,
            marketType,
            model,
            blocked: true,
        };

        // HARD RULE 1: Never trade on first run - BUT allow if secondary model confirms
        const runCount = this.runHistoryStore.getRunCount(cityId, model);
        if (runCount < 2) {
            // Check if secondary model can confirm this forecast
            const secondaryConfirmation = this.checkSecondaryModelConfirmation(cityId, model, marketType, market);
            
            if (!secondaryConfirmation.isConfirmed) {
                analysis.blockReason = 'FIRST_RUN';
                return analysis;
            }
            
            // Secondary model confirmed - log it but continue with other checks
            this.confirmationBypasses++;
            logger.info(`[ConfidenceCompressionStrategy] Secondary model ${secondaryConfirmation.secondaryModel} ` +
                `confirmed primary ${model} for ${cityId} - bypassing first run block (total bypasses: ${this.confirmationBypasses})`);
        }

        // Check confidence FIRST (needed for subsequent checks)
        const confidenceResult = this.confidenceScorer.evaluate(cityId, model, marketType);
        analysis.confidenceResult = confidenceResult;

        // HARD RULE 2: Only primary models initiate trades
        // RELAXED: Allow any model to trade if it has sufficient confidence
        const isPrimary = this.modelHierarchy.canInitiateTrade(cityId, model);
        if (!isPrimary && confidenceResult.score < 0.85) {
            analysis.blockReason = 'NOT_PRIMARY_MODEL';
            return analysis;
        }

        // Check stability - RELAXED: Allow trading even if "unstable" with higher confidence
        const stabilityResult = this.stabilityAnalyzer.isMarketStable(cityId, model, marketType);
        if (!stabilityResult.isStable && confidenceResult.score < 0.75) {
            analysis.blockReason = 'STABILITY_CHECK_FAILED';
            return analysis;
        }

        if (!confidenceResult.meetsThreshold) {
            analysis.blockReason = 'CONFIDENCE_BELOW_THRESHOLD';
            return analysis;
        }

        // Get latest forecast
        const state = this.store.getMarketState(market.market.id);
        if (!state?.lastForecast) {
            analysis.blockReason = 'EDGE_TOO_SMALL';
            return analysis;
        }

        const forecastValue = state.lastForecast.forecastValue;

        // --- SMART VERIFICATION: Check for Extreme Changes ---
        const changeCheck = this.checkExtremeChange(cityId, model, marketType, forecastValue);
        if (changeCheck.isExtreme && !changeCheck.isConfirmed) {
            analysis.blockReason = 'UNCONFIRMED_EXTREME_CHANGE';
            logger.warn(`[ConfidenceCompressionStrategy] 🚨 BLOCKED EXTREME CHANGE for ${cityId} (${marketType}): ` +
                `Change ${changeCheck.change.toFixed(1)} exceeds limit. ` +
                `Secondary model ${changeCheck.secondaryModel ?? 'NONE'} confirmation failed ` +
                `(Diff: ${changeCheck.confirmationDiff?.toFixed(1) ?? 'N/A'}).`);
            return analysis;
        }

        // Check if already captured
        if (this.isOpportunityCaptured(market.market.id, forecastValue)) {
            analysis.blockReason = 'OPPORTUNITY_ALREADY_CAPTURED';
            return analysis;
        }

        // C5: Calculate model probability - handle range markets properly
        let modelProbability: number;
        if (marketType === 'temperature' && market.metricType === 'temperature_range'
            && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
            // Range market: P(min <= X <= max) = P(X >= min) - P(X >= max)
            let minF = market.minThreshold;
            let maxF = market.maxThreshold;
            if (market.thresholdUnit === 'C') {
                minF = (minF * 9 / 5) + 32;
                maxF = (maxF * 9 / 5) + 32;
            }
            const sigma = 3.0;
            const pAboveMin = normalCDF((forecastValue - minF) / sigma);
            const pAboveMax = normalCDF((forecastValue - maxF) / sigma);
            const rawProb = Math.max(0, pAboveMin - pAboveMax);
            // Scale by confidence
            modelProbability = Math.max(0.01, Math.min(0.99,
                0.5 + (rawProb - 0.5) * confidenceResult.score));
        } else {
            const threshold = market.threshold || 0;
            const comparisonType = market.comparisonType || 'above';
            modelProbability = this.confidenceToProbability(
                confidenceResult.score,
                forecastValue,
                threshold,
                comparisonType as 'above' | 'below'
            );
        }

        // Get market probability
        const marketProbability = market.yesPrice;

        // Calculate edge
        const rawEdge = Math.abs(modelProbability - marketProbability);
        const buffer = this.uncertaintyBuffer[marketType];
        const adjustedEdge = rawEdge - this.transactionCost - buffer;

        analysis.estimatedEdge = adjustedEdge;

        if (adjustedEdge < config.minEdgeThreshold) {
            analysis.blockReason = 'EDGE_TOO_SMALL';
            logger.debug(`[ConfidenceCompressionStrategy] Blocked ${market.market.id}: ` +
                `edge ${(adjustedEdge * 100).toFixed(1)}% < ${(config.minEdgeThreshold * 100).toFixed(0)}%`);
            return analysis;
        }

        // Determine side
        const side: 'yes' | 'no' = modelProbability > marketProbability ? 'yes' : 'no';

        // Calculate position size (proportional to confidence and edge)
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
            reason: `Confidence ${(confidenceResult.score * 100).toFixed(0)}%, ` +
                `Edge ${(adjustedEdge * 100).toFixed(1)}%, ` +
                `Model ${(modelProbability * 100).toFixed(0)}% vs Market ${(marketProbability * 100).toFixed(0)}%`,
            confidence: confidenceResult.score,
            estimatedEdge: adjustedEdge,
            isGuaranteed: modelProbability > 0.95 || modelProbability < 0.05,
        };

        logger.info(`[ConfidenceCompressionStrategy] Signal: ${market.market.id} ` +
            `${side.toUpperCase()} $${size} | ${analysis.signal.reason}`);

        return analysis;
    }

    /**
     * Main detection method - scan all markets for opportunities
     * Returns signals for markets that pass all checks
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const signals: EntrySignal[] = [];

        // Reset per-scan counters
        let blocked = {
            firstRun: 0,
            notPrimary: 0,
            unstable: 0,
            lowConfidence: 0,
            lowEdge: 0,
            captured: 0,
        };

        // Track considered trades for this scan
        let scanConsidered = 0;
        let scanBlocked = 0;

        for (const market of markets) {
            scanConsidered++;
            const analysis = this.analyzeMarket(market);

            if (analysis.blocked) {
                scanBlocked++;
                
                // For first run, only count unique city-model pairs once
                if (analysis.blockReason === 'FIRST_RUN') {
                    const pairKey = `${analysis.cityId}:${analysis.model}`;
                    if (!this.firstRunCountedPairs.has(pairKey)) {
                        this.firstRunCountedPairs.add(pairKey);
                        const currentCount = this.blockReasons.get('FIRST_RUN') || 0;
                        this.blockReasons.set('FIRST_RUN', currentCount + 1);
                    }
                } else {
                    // Other block reasons still count every occurrence
                    const currentCount = this.blockReasons.get(analysis.blockReason!) || 0;
                    this.blockReasons.set(analysis.blockReason!, currentCount + 1);
                }

                switch (analysis.blockReason) {
                    case 'FIRST_RUN': blocked.firstRun++; break;
                    case 'NOT_PRIMARY_MODEL': blocked.notPrimary++; break;
                    case 'STABILITY_CHECK_FAILED': blocked.unstable++; break;
                    case 'CONFIDENCE_BELOW_THRESHOLD': blocked.lowConfidence++; break;
                    case 'EDGE_TOO_SMALL': blocked.lowEdge++; break;
                    case 'OPPORTUNITY_ALREADY_CAPTURED': blocked.captured++; break;
                    case 'UNCONFIRMED_EXTREME_CHANGE': blocked.unstable++; break; // Group with unstable for stats
                }
            } else if (analysis.signal) {
                signals.push(analysis.signal);
            }
        }

        // Update cumulative counters
        this.consideredTrades += scanConsidered;
        this.blockedTrades += scanBlocked;

        // Log at info level when markets exist so blocking reasons are visible
        if (markets.length > 0) {
            const runStats = this.runHistoryStore.getStats();
            logger.info(`[ConfidenceCompressionStrategy] Scan: ${signals.length} signals from ${scanConsidered} markets | ` +
                `Blocked: first=${blocked.firstRun}, notPrimary=${blocked.notPrimary}, unstable=${blocked.unstable}, ` +
                `lowConf=${blocked.lowConfidence}, lowEdge=${blocked.lowEdge}, captured=${blocked.captured} | ` +
                `RunHistory: ${runStats.totalKeys} keys, ${runStats.totalRuns} runs`);
        }

        return signals;
    }

    /**
     * Get run history store for external access
     */
    getRunHistoryStore(): RunHistoryStore {
        return this.runHistoryStore;
    }

    /**
     * Get stability analyzer for external access
     */
    getStabilityAnalyzer(): RunStabilityAnalyzer {
        return this.stabilityAnalyzer;
    }

    /**
     * Get confidence scorer for external access
     */
    getConfidenceScorer(): ConfidenceScorer {
        return this.confidenceScorer;
    }

    /**
     * Get model hierarchy for external access
     */
    getModelHierarchy(): ModelHierarchy {
        return this.modelHierarchy;
    }

    /**
     * Get statistics about strategy state
     */
    getStats(): {
        runHistory: ReturnType<RunHistoryStore['getStats']>;
        capturedOpportunities: number;
        confidenceConfig: ReturnType<ConfidenceScorer['getConfig']>;
        consideredTrades: number;
        blockedTrades: number;
        confirmationBypasses: number;
        blockReasons: Record<BlockReason, number>;
    } {
        // Convert blockReasons Map to plain object
        const blockReasonsObj: Record<BlockReason, number> = {
            FIRST_RUN: 0,
            NOT_PRIMARY_MODEL: 0,
            STABILITY_CHECK_FAILED: 0,
            CONFIDENCE_BELOW_THRESHOLD: 0,
            EDGE_TOO_SMALL: 0,
            EXPOSURE_CAP_REACHED: 0,
            OPPORTUNITY_ALREADY_CAPTURED: 0,
            UNCONFIRMED_EXTREME_CHANGE: 0,
        };
        for (const [reason, count] of this.blockReasons.entries()) {
            blockReasonsObj[reason] = count;
        }

        return {
            runHistory: this.runHistoryStore.getStats(),
            capturedOpportunities: this.capturedOpportunities.size,
            confidenceConfig: this.confidenceScorer.getConfig(),
            consideredTrades: this.consideredTrades,
            blockedTrades: this.blockedTrades,
            confirmationBypasses: this.confirmationBypasses,
            blockReasons: blockReasonsObj,
        };
    }

    /**
     * Clear all state (for testing)
     */
    reset(): void {
        this.runHistoryStore.clear();
        this.capturedOpportunities.clear();
        this.firstRunCountedPairs.clear();
        logger.info(`[ConfidenceCompressionStrategy] Reset complete`);
    }
}

export default ConfidenceCompressionStrategy;
