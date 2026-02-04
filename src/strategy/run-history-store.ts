/**
 * Run History Store
 * Tracks forecast history across model runs for stability analysis
 * 
 * Stores the last K runs per (model, city) to enable run-to-run comparison
 * for confidence compression trading strategy.
 */

import { ModelType } from '../weather/types.js';
import { logger } from '../logger.js';

/**
 * Record of a single model run for a city
 */
export interface RunRecord {
    model: ModelType;
    cycleHour: number;
    runDate: Date;
    cityId: string;
    maxTempC: number;
    precipFlag: boolean;
    precipAmountMm: number;
    timestamp: Date;
    source: 'API' | 'FILE';
}

/**
 * Stores and manages forecast run history for stability analysis
 */
export class RunHistoryStore {
    private history: Map<string, RunRecord[]> = new Map();
    private readonly maxRuns: number;

    constructor(maxRuns: number = 5) {
        this.maxRuns = maxRuns;
        logger.info(`[RunHistoryStore] Initialized with maxRuns=${maxRuns}`);
    }

    /**
     * Generate storage key for a city/model combination
     */
    private getKey(cityId: string, model: ModelType): string {
        return `${cityId.toLowerCase()}:${model}`;
    }

    /**
     * Add a new run record to history
     * Maintains circular buffer of last K runs
     */
    addRun(record: RunRecord): void {
        const key = this.getKey(record.cityId, record.model);

        if (!this.history.has(key)) {
            this.history.set(key, []);
        }

        const runs = this.history.get(key)!;

        // Check for duplicate run (same cycle hour and run date)
        const isDuplicate = runs.some(r =>
            r.cycleHour === record.cycleHour &&
            r.runDate.getTime() === record.runDate.getTime()
        );

        if (isDuplicate) {
            logger.debug(`[RunHistoryStore] Skipping duplicate run: ${key} cycle=${record.cycleHour}`);
            return;
        }

        // Add new record
        runs.push(record);

        // Maintain max size (circular buffer)
        while (runs.length > this.maxRuns) {
            runs.shift();
        }

        // Sort by timestamp descending (newest first)
        runs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        logger.debug(`[RunHistoryStore] Added run: ${key} cycle=${record.cycleHour}, ` +
            `temp=${record.maxTempC.toFixed(1)}°C, precip=${record.precipFlag}, ` +
            `history size=${runs.length}`);
    }

    /**
     * Get the last K runs for a city/model combination
     * Returns runs sorted by timestamp descending (newest first)
     */
    getLastKRuns(cityId: string, model: ModelType, k: number = this.maxRuns): RunRecord[] {
        const key = this.getKey(cityId, model);
        const runs = this.history.get(key) || [];
        return runs.slice(0, Math.min(k, runs.length));
    }

    /**
     * Get the most recent run for a city/model
     */
    getLatestRun(cityId: string, model: ModelType): RunRecord | undefined {
        const runs = this.getLastKRuns(cityId, model, 1);
        return runs[0];
    }

    /**
     * Get total run count for a city/model
     */
    getRunCount(cityId: string, model: ModelType): number {
        const key = this.getKey(cityId, model);
        return this.history.get(key)?.length || 0;
    }

    /**
     * Check if this is the first run for a city/model
     * CRITICAL: Used to enforce "never trade on first run" rule
     */
    isFirstRun(cityId: string, model: ModelType): boolean {
        return this.getRunCount(cityId, model) <= 1;
    }

    /**
     * Get all tracked city/model combinations
     */
    getTrackedKeys(): string[] {
        return Array.from(this.history.keys());
    }

    /**
     * Clear history for a specific city/model
     */
    clearCityModel(cityId: string, model: ModelType): void {
        const key = this.getKey(cityId, model);
        this.history.delete(key);
        logger.info(`[RunHistoryStore] Cleared history for ${key}`);
    }

    /**
     * Clear all history
     */
    clear(): void {
        this.history.clear();
        logger.info(`[RunHistoryStore] Cleared all history`);
    }

    /**
     * Get statistics about stored history
     */
    getStats(): {
        totalKeys: number;
        totalRuns: number;
        avgRunsPerKey: number;
        keyDistribution: Map<string, number>;
    } {
        const keyDistribution = new Map<string, number>();
        let totalRuns = 0;

        for (const [key, runs] of this.history) {
            keyDistribution.set(key, runs.length);
            totalRuns += runs.length;
        }

        return {
            totalKeys: this.history.size,
            totalRuns,
            avgRunsPerKey: this.history.size > 0 ? totalRuns / this.history.size : 0,
            keyDistribution,
        };
    }

    /**
     * Export history for debugging/logging
     */
    toJSON(): object {
        const result: Record<string, RunRecord[]> = {};
        for (const [key, runs] of this.history) {
            result[key] = runs;
        }
        return result;
    }
}

export default RunHistoryStore;
