/**
 * Tests for Confidence Compression Strategy Components
 * 
 * Tests cover:
 * - RunHistoryStore: storing and retrieving run history
 * - RunStabilityAnalyzer: stability detection logic
 * - ConfidenceScorer: confidence calculation
 * - ModelHierarchy: model role assignments
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RunHistoryStore, RunRecord } from '../strategy/run-history-store.js';
import { RunStabilityAnalyzer } from '../strategy/run-stability-analyzer.js';
import { ConfidenceScorer } from '../strategy/confidence-scorer.js';
import { ModelHierarchy } from '../strategy/model-hierarchy.js';
import { ModelType } from '../weather/types.js';

// Mock the logger to avoid console noise during tests
jest.mock('../logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));


describe('RunHistoryStore', () => {
    let store: RunHistoryStore;

    beforeEach(() => {
        store = new RunHistoryStore(5);
    });

    it('should add and retrieve runs', () => {
        const record: RunRecord = {
            model: 'HRRR',
            cycleHour: 12,
            runDate: new Date('2024-01-15'),
            cityId: 'new york',
            maxTempC: 20.5,
            precipFlag: false,
            precipAmountMm: 0,
            timestamp: new Date(),
            source: 'API',
        };

        store.addRun(record);
        const runs = store.getLastKRuns('new york', 'HRRR', 1);

        expect(runs.length).toBe(1);
        expect(runs[0].maxTempC).toBe(20.5);
    });

    it('should identify first run correctly', () => {
        expect(store.isFirstRun('chicago', 'HRRR')).toBe(true);

        store.addRun({
            model: 'HRRR',
            cycleHour: 12,
            runDate: new Date(),
            cityId: 'chicago',
            maxTempC: 15.0,
            precipFlag: false,
            precipAmountMm: 0,
            timestamp: new Date(),
            source: 'API',
        });

        expect(store.isFirstRun('chicago', 'HRRR')).toBe(true); // Still first run with only 1 record

        store.addRun({
            model: 'HRRR',
            cycleHour: 13,
            runDate: new Date(),
            cityId: 'chicago',
            maxTempC: 15.1,
            precipFlag: false,
            precipAmountMm: 0,
            timestamp: new Date(),
            source: 'API',
        });

        expect(store.isFirstRun('chicago', 'HRRR')).toBe(false); // Now has 2 runs
    });

    it('should maintain circular buffer of max K runs', () => {
        for (let i = 0; i < 10; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'miami',
                maxTempC: 25.0 + i,
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(Date.now() + i * 1000),
                source: 'API',
            });
        }

        const runs = store.getLastKRuns('miami', 'HRRR', 10);
        expect(runs.length).toBe(5); // Max 5 runs
    });
});

describe('RunStabilityAnalyzer', () => {
    let store: RunHistoryStore;
    let analyzer: RunStabilityAnalyzer;

    beforeEach(() => {
        store = new RunHistoryStore(5);
        analyzer = new RunStabilityAnalyzer(store);
    });

    it('should detect stable temperatures', () => {
        // Add runs with stable temperature (Δ <= 0.3°C)
        const baseTime = Date.now();
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'seattle',
                maxTempC: 18.0 + (i * 0.1), // 18.0, 18.1, 18.2
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(baseTime + i * 1000),
                source: 'API',
            });
        }

        const result = analyzer.isMarketStable('seattle', 'HRRR', 'temperature');
        expect(result.isStable).toBe(true);
        expect(result.temperatureDelta).toBeLessThanOrEqual(0.3);
    });

    it('should detect unstable temperatures', () => {
        // Add runs with unstable temperature (Δ > 0.3°C)
        const baseTime = Date.now();
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'denver',
                maxTempC: 10.0 + (i * 2), // 10.0, 12.0, 14.0 - 2°C jumps
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(baseTime + i * 1000),
                source: 'API',
            });
        }

        const result = analyzer.isMarketStable('denver', 'HRRR', 'temperature');
        expect(result.isStable).toBe(false);
    });

    it('should detect stable precipitation', () => {
        const baseTime = Date.now();
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'houston',
                maxTempC: 25.0,
                precipFlag: true, // All runs predict precip
                precipAmountMm: 5.0,
                timestamp: new Date(baseTime + i * 1000),
                source: 'API',
            });
        }

        const result = analyzer.isMarketStable('houston', 'HRRR', 'precipitation');
        expect(result.isStable).toBe(true);
        expect(result.precipConsistent).toBe(true);
    });

    it('should detect unstable precipitation', () => {
        const baseTime = Date.now();
        const precipFlags = [true, false, true]; // Flip-flopping

        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'atlanta',
                maxTempC: 20.0,
                precipFlag: precipFlags[i],
                precipAmountMm: precipFlags[i] ? 5.0 : 0,
                timestamp: new Date(baseTime + i * 1000),
                source: 'API',
            });
        }

        const result = analyzer.isMarketStable('atlanta', 'HRRR', 'precipitation');
        expect(result.precipConsistent).toBe(false);
    });
});

describe('ModelHierarchy', () => {
    let hierarchy: ModelHierarchy;

    beforeEach(() => {
        hierarchy = new ModelHierarchy();
    });

    it('should return HRRR as primary for US cities', () => {
        expect(hierarchy.getPrimaryModel('new york')).toBe('HRRR');
        expect(hierarchy.getPrimaryModel('chicago')).toBe('HRRR');
        expect(hierarchy.getPrimaryModel('miami')).toBe('HRRR');
    });

    it('should return ECMWF as primary for European cities', () => {
        expect(hierarchy.getPrimaryModel('london')).toBe('ECMWF');
        expect(hierarchy.getPrimaryModel('paris')).toBe('ECMWF');
        expect(hierarchy.getPrimaryModel('berlin')).toBe('ECMWF');
    });

    it('should only allow primary models to initiate trades', () => {
        expect(hierarchy.canInitiateTrade('new york', 'HRRR')).toBe(true);
        expect(hierarchy.canInitiateTrade('new york', 'RAP')).toBe(false);
        expect(hierarchy.canInitiateTrade('new york', 'GFS')).toBe(false);

        expect(hierarchy.canInitiateTrade('london', 'ECMWF')).toBe(true);
        expect(hierarchy.canInitiateTrade('london', 'GFS')).toBe(false);
    });

    it('should correctly identify model roles', () => {
        expect(hierarchy.getModelRole('new york', 'HRRR')).toBe('primary');
        expect(hierarchy.getModelRole('new york', 'RAP')).toBe('secondary');
        expect(hierarchy.getModelRole('new york', 'GFS')).toBe('regime');

        expect(hierarchy.getModelRole('london', 'ECMWF')).toBe('primary');
        expect(hierarchy.getModelRole('london', 'GFS')).toBe('secondary');
    });
});

describe('ConfidenceScorer', () => {
    let store: RunHistoryStore;
    let stabilityAnalyzer: RunStabilityAnalyzer;
    let hierarchy: ModelHierarchy;
    let scorer: ConfidenceScorer;

    beforeEach(() => {
        store = new RunHistoryStore(5);
        hierarchy = new ModelHierarchy();
        stabilityAnalyzer = new RunStabilityAnalyzer(store);
        scorer = new ConfidenceScorer(store, stabilityAnalyzer, hierarchy);
    });

    it('should use stricter threshold for precipitation', () => {
        const config = scorer.getConfig();
        expect(config.thresholds.precipitation).toBeGreaterThan(config.thresholds.temperature);
    });

    it('should fail threshold with no history', () => {
        const result = scorer.evaluate('new york', 'HRRR', 'temperature');
        expect(result.meetsThreshold).toBe(false);
        expect(result.score).toBe(0);
    });

    it('should calculate weighted confidence correctly', () => {
        // Add stable runs to both primary and secondary models
        const baseTime = Date.now();

        // HRRR runs (primary for US)
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'HRRR',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'chicago',
                maxTempC: 15.0 + (i * 0.05), // Very stable
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(baseTime + i * 1000),
                source: 'API',
            });
        }

        // RAP runs (secondary for US)
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'RAP',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'chicago',
                maxTempC: 15.1, // Similar to HRRR
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(baseTime + i * 1000 + 500),
                source: 'API',
            });
        }

        // GFS runs (regime for US)
        for (let i = 0; i < 3; i++) {
            store.addRun({
                model: 'GFS',
                cycleHour: i,
                runDate: new Date(),
                cityId: 'chicago',
                maxTempC: 15.2, // Also similar
                precipFlag: false,
                precipAmountMm: 0,
                timestamp: new Date(baseTime + i * 1000 + 1000),
                source: 'API',
            });
        }

        const result = scorer.evaluate('chicago', 'HRRR', 'temperature');

        // With good stability and agreement, should have decent confidence
        expect(result.score).toBeGreaterThan(0);
        expect(result.components.runStability).toBeGreaterThan(0);
    });
});
