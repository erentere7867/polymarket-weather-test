/**
 * Confidence Scorer
 * Computes confidence score from stability + hierarchy agreement + regime support
 * 
 * confidence_score = w1 * run_to_run_stability 
 *                  + w2 * hierarchy_agreement 
 *                  + w3 * regime_support
 * 
 * Trades allowed ONLY if confidence_score ≥ threshold
 * Threshold is STRICTER for precipitation than temperature
 */

import { ModelType } from '../weather/types.js';
import { RunStabilityAnalyzer, StabilityResult } from './run-stability-analyzer.js';
import { ModelHierarchy } from './model-hierarchy.js';
import { RunHistoryStore, RunRecord } from './run-history-store.js';
import { logger } from '../logger.js';

/**
 * Inputs to confidence calculation
 */
export interface ConfidenceInputs {
    runStability: number;        // [0,1] from stability analyzer
    hierarchyAgreement: number;  // [0,1] primary vs secondary match
    regimeSupport: number;       // [0,1] synoptic consistency
}

/**
 * Result of confidence evaluation
 */
export interface ConfidenceResult {
    score: number;              // [0,1]
    components: ConfidenceInputs;
    meetsThreshold: boolean;
    thresholdUsed: number;
    reason: string;
}

/**
 * Configuration for confidence scoring
 */
export interface ConfidenceConfig {
    weights: {
        w1: number;  // run_to_run_stability weight
        w2: number;  // hierarchy_agreement weight
        w3: number;  // regime_support weight
    };
    thresholds: {
        temperature: number;      // Threshold for temp markets
        precipitation: number;    // Stricter threshold for precip
    };
}

const DEFAULT_CONFIG: ConfidenceConfig = {
    weights: {
        w1: 0.4,  // 40% stability
        w2: 0.4,  // 40% hierarchy agreement
        w3: 0.2,  // 20% regime support
    },
    thresholds: {
        temperature: 0.60,    // 60% threshold for temp
        precipitation: 0.75,  // 75% threshold for precip (stricter)
    },
};

/**
 * Computes confidence scores for trading decisions
 */
export class ConfidenceScorer {
    private config: ConfidenceConfig;
    private stabilityAnalyzer: RunStabilityAnalyzer;
    private modelHierarchy: ModelHierarchy;
    private runHistoryStore: RunHistoryStore;

    constructor(
        runHistoryStore: RunHistoryStore,
        stabilityAnalyzer: RunStabilityAnalyzer,
        modelHierarchy: ModelHierarchy,
        config: Partial<ConfidenceConfig> = {}
    ) {
        this.runHistoryStore = runHistoryStore;
        this.stabilityAnalyzer = stabilityAnalyzer;
        this.modelHierarchy = modelHierarchy;
        this.config = {
            weights: { ...DEFAULT_CONFIG.weights, ...config.weights },
            thresholds: { ...DEFAULT_CONFIG.thresholds, ...config.thresholds },
        };
        logger.info(`[ConfidenceScorer] Initialized with weights: w1=${this.config.weights.w1}, ` +
            `w2=${this.config.weights.w2}, w3=${this.config.weights.w3}`);
    }

    /**
     * Calculate raw confidence score from inputs
     */
    calculateConfidence(inputs: ConfidenceInputs): number {
        const { w1, w2, w3 } = this.config.weights;
        return (
            w1 * inputs.runStability +
            w2 * inputs.hierarchyAgreement +
            w3 * inputs.regimeSupport
        );
    }

    /**
     * Calculate hierarchy agreement between primary and secondary models
     * Returns [0,1] where 1 = perfect agreement
     */
    calculateHierarchyAgreement(
        cityId: string,
        marketType: 'temperature' | 'precipitation'
    ): number {
        const primaryModel = this.modelHierarchy.getPrimaryModel(cityId);
        const secondaryModel = this.modelHierarchy.getSecondaryModel(cityId);

        // Get latest runs from both models
        const primaryRun = this.runHistoryStore.getLatestRun(cityId, primaryModel);
        const secondaryRun = this.runHistoryStore.getLatestRun(cityId, secondaryModel);

        if (!primaryRun || !secondaryRun) {
            logger.debug(`[ConfidenceScorer] Missing run data for hierarchy agreement: ` +
                `primary=${!!primaryRun}, secondary=${!!secondaryRun}`);
            return 0;
        }

        if (marketType === 'temperature') {
            // Agreement based on how close the temperature forecasts are
            const tempDiff = Math.abs(primaryRun.maxTempC - secondaryRun.maxTempC);
            // Perfect agreement at 0°C diff, drops linearly to 0 at 3°C diff
            return Math.max(0, 1 - tempDiff / 3);
        } else {
            // Perfect agreement if both predict same precip flag
            return primaryRun.precipFlag === secondaryRun.precipFlag ? 1.0 : 0.0;
        }
    }

    /**
     * Calculate regime support from synoptic background model
     * Returns [0,1] where 1 = strong regime support
     */
    calculateRegimeSupport(
        cityId: string,
        marketType: 'temperature' | 'precipitation'
    ): number {
        const regimeModel = this.modelHierarchy.getRegimeModel(cityId);
        if (!regimeModel) {
            return 0.5; // Neutral if no regime model
        }

        const primaryModel = this.modelHierarchy.getPrimaryModel(cityId);
        const primaryRun = this.runHistoryStore.getLatestRun(cityId, primaryModel);
        const regimeRun = this.runHistoryStore.getLatestRun(cityId, regimeModel);

        if (!primaryRun || !regimeRun) {
            return 0.5; // Neutral if missing data
        }

        if (marketType === 'temperature') {
            // Check if regime model supports the direction
            const tempDiff = Math.abs(primaryRun.maxTempC - regimeRun.maxTempC);
            // Allow more slack for regime model (global vs regional)
            return Math.max(0, 1 - tempDiff / 5);
        } else {
            // Regime support for precip
            return primaryRun.precipFlag === regimeRun.precipFlag ? 1.0 : 0.3;
        }
    }

    /**
     * Full confidence evaluation for a market
     */
    evaluate(
        cityId: string,
        model: ModelType,
        marketType: 'temperature' | 'precipitation'
    ): ConfidenceResult {
        // 1. Get stability score
        const stabilityResult = this.stabilityAnalyzer.isMarketStable(cityId, model, marketType);

        // 2. Get hierarchy agreement
        const hierarchyAgreement = this.calculateHierarchyAgreement(cityId, marketType);

        // 3. Get regime support
        const regimeSupport = this.calculateRegimeSupport(cityId, marketType);

        // Build inputs
        const inputs: ConfidenceInputs = {
            runStability: stabilityResult.stabilityScore,
            hierarchyAgreement,
            regimeSupport,
        };

        // Calculate score
        const score = this.calculateConfidence(inputs);

        // Get threshold for this market type
        const threshold = marketType === 'precipitation'
            ? this.config.thresholds.precipitation
            : this.config.thresholds.temperature;

        const meetsThreshold = score >= threshold;

        const result: ConfidenceResult = {
            score,
            components: inputs,
            meetsThreshold,
            thresholdUsed: threshold,
            reason: meetsThreshold
                ? `Confidence ${(score * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}% threshold`
                : `Confidence ${(score * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}% threshold`,
        };

        logger.debug(`[ConfidenceScorer] ${cityId}/${marketType}: ` +
            `stability=${inputs.runStability.toFixed(2)}, ` +
            `hierarchy=${inputs.hierarchyAgreement.toFixed(2)}, ` +
            `regime=${inputs.regimeSupport.toFixed(2)}, ` +
            `score=${score.toFixed(2)}, meets=${meetsThreshold}`);

        return result;
    }

    /**
     * Quick check if a market meets confidence threshold
     */
    meetsThreshold(
        cityId: string,
        model: ModelType,
        marketType: 'temperature' | 'precipitation'
    ): boolean {
        return this.evaluate(cityId, model, marketType).meetsThreshold;
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<ConfidenceConfig>): void {
        if (config.weights) {
            this.config.weights = { ...this.config.weights, ...config.weights };
        }
        if (config.thresholds) {
            this.config.thresholds = { ...this.config.thresholds, ...config.thresholds };
        }
        logger.info(`[ConfidenceScorer] Config updated`);
    }

    /**
     * Get current configuration
     */
    getConfig(): ConfidenceConfig {
        return {
            weights: { ...this.config.weights },
            thresholds: { ...this.config.thresholds },
        };
    }
}

export default ConfidenceScorer;
