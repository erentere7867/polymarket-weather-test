/**
 * Run Stability Analyzer
 * Core stability detection logic for confidence compression strategy
 * 
 * STABILITY CRITERIA:
 * - Temperature: |Δmax_temp| ≤ 0.3°C across ≥2 consecutive runs
 * - Precipitation: same yes/no flag across ≥2 consecutive runs
 * 
 * If stability is NOT present → DO NOT TRADE
 */

import { ModelType } from '../weather/types.js';
import { RunHistoryStore, RunRecord } from './run-history-store.js';
import { logger } from '../logger.js';

/**
 * Result of stability analysis
 */
export interface StabilityResult {
    isStable: boolean;
    runsAnalyzed: number;
    consecutiveStableRuns: number;
    temperatureDelta?: number;      // Max Δ between consecutive runs
    precipConsistent?: boolean;     // All runs have same precip flag
    reason: string;
    stabilityScore: number;         // [0,1] for confidence calculation
}

/**
 * Configuration for stability analysis
 */
export interface StabilityConfig {
    tempStabilityThreshold: number;  // Max allowed Δ in °C
    minStableRuns: number;           // Minimum runs needed for stability
    minPersistenceHours: number;     // Minimum hours forecast must persist
    precipStepsThreshold: number;    // N steps with precip = precip day
    precipAmountThreshold: number;   // mm threshold for precip flag
}

const DEFAULT_CONFIG: StabilityConfig = {
    tempStabilityThreshold: 0.2,     // 0.2°C - tighter threshold for higher confidence
    minStableRuns: 3,                // ≥3 consecutive runs - more persistence required
    minPersistenceHours: 1,          // Minimum hours a forecast must persist
    precipStepsThreshold: 3,         // At least 3 hours of precip
    precipAmountThreshold: 0.1,      // 0.1mm threshold
};

/**
 * Analyzes run-to-run stability for trading decisions
 */
export class RunStabilityAnalyzer {
    private config: StabilityConfig;
    private runHistoryStore: RunHistoryStore;

    constructor(runHistoryStore: RunHistoryStore, config: Partial<StabilityConfig> = {}) {
        this.runHistoryStore = runHistoryStore;
        this.config = { ...DEFAULT_CONFIG, ...config };
        logger.info(`[RunStabilityAnalyzer] Initialized with config:`, this.config);
    }

    /**
     * Check temperature stability across runs
     * Returns stable if |Δmax_temp| ≤ threshold across ≥minStableRuns
     */
    checkTemperatureStability(runs: RunRecord[]): StabilityResult {
        if (runs.length < this.config.minStableRuns) {
            return {
                isStable: false,
                runsAnalyzed: runs.length,
                consecutiveStableRuns: 0,
                reason: `Insufficient runs: ${runs.length} < ${this.config.minStableRuns} required`,
                stabilityScore: 0,
            };
        }

        // Calculate max delta between consecutive runs
        let maxDelta = 0;
        let consecutiveStable = 1;
        let maxConsecutiveStable = 1;

        for (let i = 0; i < runs.length - 1; i++) {
            const delta = Math.abs(runs[i].maxTempC - runs[i + 1].maxTempC);
            maxDelta = Math.max(maxDelta, delta);

            if (delta <= this.config.tempStabilityThreshold) {
                consecutiveStable++;
                maxConsecutiveStable = Math.max(maxConsecutiveStable, consecutiveStable);
            } else {
                consecutiveStable = 1;
            }
        }

        const isStable = maxConsecutiveStable >= this.config.minStableRuns &&
            maxDelta <= this.config.tempStabilityThreshold;

        // Calculate stability score [0,1]
        // Higher score for smaller deltas and more consecutive stable runs
        const deltaScore = Math.max(0, 1 - (maxDelta / (this.config.tempStabilityThreshold * 3)));
        const runScore = Math.min(1, maxConsecutiveStable / 4);
        const stabilityScore = isStable ? (deltaScore * 0.6 + runScore * 0.4) : 0;

        return {
            isStable,
            runsAnalyzed: runs.length,
            consecutiveStableRuns: maxConsecutiveStable,
            temperatureDelta: maxDelta,
            reason: isStable
                ? `Stable: Δ${maxDelta.toFixed(2)}°C ≤ ${this.config.tempStabilityThreshold}°C across ${maxConsecutiveStable} runs`
                : `Unstable: Δ${maxDelta.toFixed(2)}°C > ${this.config.tempStabilityThreshold}°C`,
            stabilityScore,
        };
    }

    /**
     * Check precipitation stability across runs
     * Returns stable if same yes/no outcome across ≥minStableRuns
     */
    checkPrecipitationStability(runs: RunRecord[]): StabilityResult {
        if (runs.length < this.config.minStableRuns) {
            return {
                isStable: false,
                runsAnalyzed: runs.length,
                consecutiveStableRuns: 0,
                reason: `Insufficient runs: ${runs.length} < ${this.config.minStableRuns} required`,
                stabilityScore: 0,
            };
        }

        // Check for consistent precip flag
        let consecutiveConsistent = 1;
        let maxConsecutiveConsistent = 1;
        const referenceFlag = runs[0].precipFlag;

        for (let i = 0; i < runs.length - 1; i++) {
            if (runs[i].precipFlag === runs[i + 1].precipFlag) {
                consecutiveConsistent++;
                maxConsecutiveConsistent = Math.max(maxConsecutiveConsistent, consecutiveConsistent);
            } else {
                consecutiveConsistent = 1;
            }
        }

        // Check if all runs agree
        const allSameFlag = runs.every(r => r.precipFlag === referenceFlag);
        const isStable = maxConsecutiveConsistent >= this.config.minStableRuns;

        // Calculate stability score
        const consistencyScore = allSameFlag ? 1.0 : (maxConsecutiveConsistent / runs.length);
        const runScore = Math.min(1, maxConsecutiveConsistent / 4);
        const stabilityScore = isStable ? (consistencyScore * 0.7 + runScore * 0.3) : 0;

        return {
            isStable,
            runsAnalyzed: runs.length,
            consecutiveStableRuns: maxConsecutiveConsistent,
            precipConsistent: allSameFlag,
            reason: isStable
                ? `Stable: precip=${referenceFlag ? 'YES' : 'NO'} consistent across ${maxConsecutiveConsistent} runs`
                : `Unstable: precip flag changed between runs`,
            stabilityScore,
        };
    }

    /**
     * Check cross-model agreement as a stability substitute.
     * When same-model runs are insufficient, multiple models agreeing
     * on the same value provides a form of "spatial stability".
     */
    private checkCrossModelStability(
        cityId: string,
        primaryModel: ModelType,
        marketType: 'temperature' | 'precipitation'
    ): { score: number; modelsAgreeing: number; reason: string } {
        // Gather latest run from each model that has data for this city
        const allModels: ModelType[] = ['HRRR', 'RAP', 'GFS', 'ECMWF'];
        const values: { model: ModelType; value: number }[] = [];

        for (const m of allModels) {
            const latest = this.runHistoryStore.getLatestRun(cityId, m);
            if (latest) {
                if (marketType === 'temperature') {
                    values.push({ model: m, value: latest.maxTempC });
                } else {
                    values.push({ model: m, value: latest.precipFlag ? 1 : 0 });
                }
            }
        }

        if (values.length < 2) {
            return { score: 0, modelsAgreeing: values.length, reason: 'Insufficient cross-model data' };
        }

        // Calculate max disagreement
        const vals = values.map(v => v.value);
        const maxDiff = Math.max(...vals) - Math.min(...vals);

        let score: number;
        if (marketType === 'temperature') {
            // Agreement threshold: within 1°C across models is excellent
            score = Math.max(0, 1 - maxDiff / 2.0);
        } else {
            // Precip: all agree = 1.0, disagree = 0.0
            score = maxDiff === 0 ? 1.0 : 0.0;
        }

        // Bonus for more models agreeing
        const modelBonus = Math.min(1, values.length / 3);
        score = score * 0.7 + modelBonus * 0.3;

        return {
            score,
            modelsAgreeing: values.length,
            reason: `Cross-model: ${values.length} models, maxDiff=${maxDiff.toFixed(2)}, score=${score.toFixed(2)}`,
        };
    }

    /**
     * Check market stability for a city/model combination
     */
    isMarketStable(
        cityId: string,
        model: ModelType,
        marketType: 'temperature' | 'precipitation'
    ): StabilityResult {
        const runs = this.runHistoryStore.getLastKRuns(cityId, model, this.config.minStableRuns + 2);

        if (runs.length === 0) {
            // No same-model runs, but cross-model agreement may still provide stability
            const crossModel = this.checkCrossModelStability(cityId, model, marketType);
            return {
                isStable: false,
                runsAnalyzed: 0,
                consecutiveStableRuns: 0,
                reason: crossModel.score > 0.5
                    ? `No same-model runs | ${crossModel.reason}`
                    : 'No run history available',
                stabilityScore: crossModel.score > 0.5 ? crossModel.score * 0.7 : 0,
            };
        }

        // Check same-model run-to-run stability
        let result: StabilityResult;
        if (marketType === 'temperature') {
            result = this.checkTemperatureStability(runs);
        } else {
            result = this.checkPrecipitationStability(runs);
        }

        // If same-model stability failed due to insufficient runs (not actual instability),
        // use cross-model agreement as a substitute stability signal
        if (!result.isStable && runs.length < this.config.minStableRuns) {
            const crossModel = this.checkCrossModelStability(cityId, model, marketType);
            if (crossModel.score > 0.5) {
                // Cross-model agreement provides partial stability
                result.stabilityScore = crossModel.score * 0.7; // Discount vs same-model
                result.reason = `${result.reason} | ${crossModel.reason}`;
                logger.debug(`[RunStabilityAnalyzer] Cross-model stability for ${cityId}/${model}: ${crossModel.reason}`);
            }
        }

        return result;
    }

    /**
     * Get combined stability for both market types
     */
    getCombinedStability(cityId: string, model: ModelType): {
        temperature: StabilityResult;
        precipitation: StabilityResult;
        overallStable: boolean;
    } {
        const tempStability = this.isMarketStable(cityId, model, 'temperature');
        const precipStability = this.isMarketStable(cityId, model, 'precipitation');

        return {
            temperature: tempStability,
            precipitation: precipStability,
            overallStable: tempStability.isStable && precipStability.isStable,
        };
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<StabilityConfig>): void {
        this.config = { ...this.config, ...config };
        logger.info(`[RunStabilityAnalyzer] Config updated:`, this.config);
    }

    /**
     * Get current configuration
     */
    getConfig(): StabilityConfig {
        return { ...this.config };
    }
}

export default RunStabilityAnalyzer;
