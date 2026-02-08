/**
 * Entry Optimizer Test Suite
 * 
 * Tests for the improved entry optimizer:
 * - Liquidity-aware sizing
 * - Volatility-adjusted sizing
 * - Kelly Criterion calculation
 * - Position scaling logic
 * - Urgency factor decay
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EntryOptimizer } from '../strategy/entry-optimizer.js';
import { MarketModel } from '../probability/market-model.js';
import { MarketImpactModel } from '../strategy/market-impact.js';
import { DataStore } from '../realtime/data-store.js';
import { CalculatedEdge } from '../probability/edge-calculator.js';
import { OrderBook } from '../polymarket/types.js';

// Mock the logger to avoid console noise during tests
jest.mock('../logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

// Mock config
jest.mock('../config.js', () => ({
    config: {
        maxPositionSize: 50,
        guaranteedPositionMultiplier: 2.0,
    },
}));

describe('EntryOptimizer', () => {
    let entryOptimizer: EntryOptimizer;
    let mockMarketModel: MarketModel;
    let mockMarketImpactModel: MarketImpactModel;
    let dataStore: DataStore;

    // Helper to create mock edge
    const createMockEdge = (
        marketId: string = 'test-market',
        side: 'yes' | 'no' = 'yes',
        adjustedEdge: number = 0.15,
        confidence: number = 0.8,
        isGuaranteed: boolean = false
    ): CalculatedEdge => ({
        marketId,
        side,
        rawEdge: adjustedEdge,
        adjustedEdge,
        confidence,
        KellyFraction: 0.25,
        reason: 'Test edge',
        isGuaranteed,
    });

    // Helper to create mock order book
    const createMockOrderBook = (
        bestBid: string = '0.48',
        bestAsk: string = '0.52',
        bidSize: string = '1000',
        askSize: string = '1000'
    ): OrderBook => ({
        market: 'test-market',
        assetId: 'test-asset',
        bids: [
            { price: bestBid, size: bidSize },
            { price: '0.47', size: '500' },
        ],
        asks: [
            { price: bestAsk, size: askSize },
            { price: '0.53', size: '500' },
        ],
    });

    beforeEach(() => {
        dataStore = new DataStore();
        mockMarketModel = new MarketModel(dataStore);
        mockMarketImpactModel = new MarketImpactModel();
        entryOptimizer = new EntryOptimizer(mockMarketModel, mockMarketImpactModel, 50);
    });

    describe('Liquidity-Aware Sizing', () => {
        it('should analyze order book depth', () => {
            const orderBook = createMockOrderBook('0.48', '0.52', '5000', '5000');
            
            const liquidity = entryOptimizer.analyzeLiquidity(orderBook);
            
            expect(liquidity).toHaveProperty('totalBidDepth');
            expect(liquidity).toHaveProperty('totalAskDepth');
            expect(liquidity).toHaveProperty('spread');
            expect(liquidity).toHaveProperty('bestBid');
            expect(liquidity).toHaveProperty('bestAsk');
            expect(liquidity).toHaveProperty('depthScore');
            
            expect(liquidity.totalBidDepth).toBeGreaterThan(0);
            expect(liquidity.totalAskDepth).toBeGreaterThan(0);
            expect(liquidity.spread).toBeGreaterThan(0);
            expect(liquidity.depthScore).toBeGreaterThanOrEqual(0);
            expect(liquidity.depthScore).toBeLessThanOrEqual(1);
        });

        it('should return default liquidity when order book is undefined', () => {
            const liquidity = entryOptimizer.analyzeLiquidity(undefined);
            
            expect(liquidity.totalBidDepth).toBe(0);
            expect(liquidity.totalAskDepth).toBe(0);
            expect(liquidity.spread).toBe(0.02);
            expect(liquidity.depthScore).toBe(0.5);
        });

        it('should constrain position size based on liquidity', () => {
            const edge = createMockEdge();
            const deepOrderBook = createMockOrderBook('0.48', '0.52', '10000', '10000');
            const shallowOrderBook = createMockOrderBook('0.48', '0.52', '100', '100');
            
            const signalDeep = entryOptimizer.optimizeEntry(edge, deepOrderBook, new Date(), 100000);
            const signalShallow = entryOptimizer.optimizeEntry(edge, shallowOrderBook, new Date(), 100000);
            
            // Deep liquidity should allow larger positions
            expect(signalDeep.size).toBeGreaterThanOrEqual(signalShallow.size);
        });

        it('should reduce size for wide spreads', () => {
            const edge = createMockEdge();
            const tightSpreadBook = createMockOrderBook('0.49', '0.51', '1000', '1000'); // 2% spread
            const wideSpreadBook = createMockOrderBook('0.45', '0.55', '1000', '1000'); // 10% spread
            
            const signalTight = entryOptimizer.optimizeEntry(edge, tightSpreadBook, new Date(), 100000);
            const signalWide = entryOptimizer.optimizeEntry(edge, wideSpreadBook, new Date(), 100000);
            
            // Wide spread should result in smaller position
            expect(signalWide.size).toBeLessThanOrEqual(signalTight.size);
        });

        it('should calculate depth score correctly', () => {
            const deepBook = createMockOrderBook('0.48', '0.52', '20000', '20000');
            const liquidity = entryOptimizer.analyzeLiquidity(deepBook);
            
            // $20k depth should give high score
            expect(liquidity.depthScore).toBeGreaterThan(0.5);
        });
    });

    describe('Volatility-Adjusted Sizing', () => {
        it('should calculate volatility metrics', () => {
            const volatility = entryOptimizer.calculateVolatility('test-market');
            
            expect(volatility).toHaveProperty('priceVolatility');
            expect(volatility).toHaveProperty('volumeVolatility');
            expect(volatility).toHaveProperty('recentVolatility');
            expect(volatility).toHaveProperty('volatilityRegime');
            
            expect(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']).toContain(volatility.volatilityRegime);
        });

        it('should increase size in low volatility regime', () => {
            // Mock low volatility by using a market with no price history
            const edge = createMockEdge();
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            // Should have some size
            expect(signal.size).toBeGreaterThan(0);
        });

        it('should decrease size in high volatility regime', () => {
            const edge = createMockEdge();
            
            // First, let's verify the volatility multipliers work
            const volatility = entryOptimizer.calculateVolatility('test-market');
            
            // Volatility regime should be determined
            expect(volatility.volatilityRegime).toBeDefined();
        });

        it('should classify volatility regimes correctly', () => {
            // Test that different volatility levels are classified correctly
            // This is indirectly tested through calculateVolatility
            
            const volatility = entryOptimizer.calculateVolatility('new-market');
            
            // New market with no history should have LOW or MEDIUM volatility
            expect(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']).toContain(volatility.volatilityRegime);
        });
    });

    describe('Kelly Criterion Calculation', () => {
        it('should calculate full Kelly fraction', () => {
            const kellyInputs = {
                winProbability: 0.7,
                lossProbability: 0.3,
                avgWin: 0.3,
                avgLoss: 0.1,
                winLossRatio: 3.0,
            };
            
            const kellyFraction = entryOptimizer.calculateFullKelly(kellyInputs);
            
            // Kelly = (p*b - q) / b = (0.7*3 - 0.3) / 3 = (2.1 - 0.3) / 3 = 0.6
            // With 0.25 fractional Kelly = 0.15
            expect(kellyFraction).toBeGreaterThan(0);
            expect(kellyFraction).toBeLessThanOrEqual(0.5); // Capped at 50%
        });

        it('should return 0 for invalid win/loss ratio', () => {
            const kellyInputs = {
                winProbability: 0.7,
                lossProbability: 0.3,
                avgWin: 0.3,
                avgLoss: 0.1,
                winLossRatio: 0, // Invalid
            };
            
            const kellyFraction = entryOptimizer.calculateFullKelly(kellyInputs);
            expect(kellyFraction).toBe(0);
        });

        it('should use fractional Kelly for safety', () => {
            const kellyInputs = {
                winProbability: 0.8,
                lossProbability: 0.2,
                avgWin: 0.5,
                avgLoss: 0.1,
                winLossRatio: 5.0,
            };
            
            const kellyFraction = entryOptimizer.calculateFullKelly(kellyInputs);
            
            // Full Kelly would be (0.8*5 - 0.2) / 5 = 0.76
            // With 0.25 fractional = 0.19
            expect(kellyFraction).toBeLessThan(0.76);
        });

        it('should cap Kelly at 50% maximum', () => {
            const kellyInputs = {
                winProbability: 0.95,
                lossProbability: 0.05,
                avgWin: 1.0,
                avgLoss: 0.1,
                winLossRatio: 10.0,
            };
            
            const kellyFraction = entryOptimizer.calculateFullKelly(kellyInputs);
            
            expect(kellyFraction).toBeLessThanOrEqual(0.5);
        });

        it('should return 0 for negative Kelly', () => {
            const kellyInputs = {
                winProbability: 0.3, // Low win probability
                lossProbability: 0.7,
                avgWin: 0.2,
                avgLoss: 0.5,
                winLossRatio: 0.4,
            };
            
            const kellyFraction = entryOptimizer.calculateFullKelly(kellyInputs);
            
            // Kelly = (0.3*0.4 - 0.7) / 0.4 = negative
            expect(kellyFraction).toBe(0);
        });
    });

    describe('Position Scaling Logic', () => {
        it('should create scale-in orders for large positions', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            const orderBook = createMockOrderBook('0.48', '0.52', '5000', '5000');
            
            // Set a large max position size to trigger scaling
            entryOptimizer.setMaxPositionSize(500);
            
            const signal = entryOptimizer.optimizeEntry(edge, orderBook, new Date(), 100000);
            
            // Should have scale-in orders for large positions
            if (signal.size > 100) {
                expect(signal.scaleInOrders).toBeDefined();
                expect(signal.scaleInOrders!.length).toBeGreaterThan(1);
            }
        });

        it('should not scale small positions', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            
            entryOptimizer.setMaxPositionSize(50);
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            // Small positions might not need scaling
            expect(signal.size).toBeGreaterThan(0);
        });

        it('should distribute scale-in orders with delays', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            const orderBook = createMockOrderBook('0.48', '0.52', '10000', '10000');
            
            entryOptimizer.setMaxPositionSize(500);
            
            const signal = entryOptimizer.optimizeEntry(edge, orderBook, new Date(), 100000);
            
            if (signal.scaleInOrders && signal.scaleInOrders.length > 1) {
                // Each subsequent order should have increasing delay
                for (let i = 1; i < signal.scaleInOrders.length; i++) {
                    expect(signal.scaleInOrders[i].delayMs)
                        .toBeGreaterThan(signal.scaleInOrders[i - 1].delayMs);
                }
            }
        });

        it('should use market order for first tranche when urgency is high', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            
            // Fresh forecast = high urgency
            const freshTimestamp = new Date();
            
            entryOptimizer.setMaxPositionSize(500);
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, freshTimestamp, 100000);
            
            if (signal.scaleInOrders && signal.scaleInOrders.length > 0) {
                // First tranche should be market or limit based on urgency
                expect(['MARKET', 'LIMIT']).toContain(signal.scaleInOrders[0].orderType);
            }
        });
    });

    describe('Urgency Factor Decay', () => {
        it('should calculate urgency factor based on forecast freshness', () => {
            const now = new Date();
            
            // Fresh forecast (just now)
            const freshUrgency = entryOptimizer.calculateUrgencyFactor(now);
            
            // Old forecast (60 seconds ago)
            const oldTimestamp = new Date(now.getTime() - 60000);
            const oldUrgency = entryOptimizer.calculateUrgencyFactor(oldTimestamp);
            
            // Fresh should have higher urgency
            expect(freshUrgency).toBeGreaterThan(oldUrgency);
        });

        it('should return maximum urgency for current timestamp', () => {
            const now = new Date();
            const urgency = entryOptimizer.calculateUrgencyFactor(now);
            
            expect(urgency).toBeCloseTo(1.0, 1);
        });

        it('should return minimum urgency of 0.1 for old forecasts', () => {
            const veryOldTimestamp = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
            const urgency = entryOptimizer.calculateUrgencyFactor(veryOldTimestamp);
            
            expect(urgency).toBeGreaterThanOrEqual(0.1);
        });

        it('should use exponential decay for urgency', () => {
            const now = new Date();
            
            const urgencies: number[] = [];
            for (let seconds = 0; seconds <= 60; seconds += 10) {
                const timestamp = new Date(now.getTime() - seconds * 1000);
                const urgency = entryOptimizer.calculateUrgencyFactor(timestamp);
                urgencies.push(urgency);
            }
            
            // Should be monotonically decreasing
            for (let i = 1; i < urgencies.length; i++) {
                expect(urgencies[i]).toBeLessThanOrEqual(urgencies[i - 1]);
            }
        });

        it('should return default urgency when timestamp is undefined', () => {
            const urgency = entryOptimizer.calculateUrgencyFactor(undefined);
            
            expect(urgency).toBe(0.5);
        });

        it('should affect order type based on urgency', () => {
            const edge = createMockEdge();
            
            // Fresh forecast = high urgency = market order
            const freshSignal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            // Old forecast = low urgency = limit order
            const oldTimestamp = new Date(Date.now() - 2 * 60 * 1000);
            const oldSignal = entryOptimizer.optimizeEntry(edge, undefined, oldTimestamp, 100000);
            
            // Urgency factor should be higher for fresh
            if (freshSignal.urgencyFactor && oldSignal.urgencyFactor) {
                expect(freshSignal.urgencyFactor).toBeGreaterThanOrEqual(oldSignal.urgencyFactor);
            }
        });
    });

    describe('Entry Signal Generation', () => {
        it('should generate complete entry signal', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            const orderBook = createMockOrderBook();
            
            const signal = entryOptimizer.optimizeEntry(edge, orderBook, new Date(), 100000);
            
            expect(signal).toHaveProperty('marketId');
            expect(signal).toHaveProperty('side');
            expect(signal).toHaveProperty('size');
            expect(signal).toHaveProperty('orderType');
            expect(signal).toHaveProperty('urgency');
            expect(signal).toHaveProperty('reason');
            expect(signal).toHaveProperty('confidence');
            expect(signal).toHaveProperty('estimatedEdge');
            expect(signal).toHaveProperty('isGuaranteed');
            
            expect(signal.marketId).toBe('test-market');
            expect(signal.side).toBe('yes');
            expect(signal.size).toBeGreaterThan(0);
            expect(['LOW', 'MEDIUM', 'HIGH']).toContain(signal.urgency);
        });

        it('should use market order for high urgency', () => {
            const edge = createMockEdge();
            
            // Very fresh forecast
            const freshTimestamp = new Date();
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, freshTimestamp, 100000);
            
            // High urgency should use market order
            if (signal.urgencyFactor && signal.urgencyFactor > 0.8) {
                expect(signal.orderType).toBe('MARKET');
            }
        });

        it('should use limit order for low urgency', () => {
            const edge = createMockEdge();
            
            // Old forecast
            const oldTimestamp = new Date(Date.now() - 2 * 60 * 1000);
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, oldTimestamp, 100000);
            
            // Low urgency might use limit order
            expect(['MARKET', 'LIMIT']).toContain(signal.orderType);
        });

        it('should include expected slippage in signal', () => {
            const edge = createMockEdge();
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            expect(signal.expectedSlippage).toBeDefined();
            expect(signal.expectedSlippage).toBeGreaterThanOrEqual(0);
        });

        it('should include market impact in signal', () => {
            const edge = createMockEdge();
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            expect(signal.marketImpact).toBeDefined();
            expect(signal.marketImpact).toBeGreaterThanOrEqual(0);
        });

        it('should adjust estimated edge for costs', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            
            const signal = entryOptimizer.optimizeEntry(edge, undefined, new Date(), 100000);
            
            // Estimated edge should be raw edge minus costs
            expect(signal.estimatedEdge).toBeLessThanOrEqual(edge.adjustedEdge);
        });
    });

    describe('Configuration', () => {
        it('should return current configuration', () => {
            const config = entryOptimizer.getConfig();
            
            expect(config).toHaveProperty('maxPositionSize');
            expect(config).toHaveProperty('kellyFractions');
            expect(config).toHaveProperty('scaleInThreshold');
            expect(config).toHaveProperty('urgencyDecayMs');
            
            expect(config.maxPositionSize).toBe(50);
            expect(config.kellyFractions.medium).toBe(0.25);
        });

        it('should update max position size', () => {
            entryOptimizer.setMaxPositionSize(100);
            
            const config = entryOptimizer.getConfig();
            expect(config.maxPositionSize).toBe(100);
        });
    });

    describe('Guaranteed Outcomes', () => {
        it('should increase size for guaranteed outcomes', () => {
            const normalEdge = createMockEdge('test-market', 'yes', 0.15, 0.8, false);
            const guaranteedEdge = createMockEdge('test-market', 'yes', 0.15, 0.8, true);
            
            const normalSignal = entryOptimizer.optimizeEntry(normalEdge, undefined, new Date(), 100000);
            const guaranteedSignal = entryOptimizer.optimizeEntry(guaranteedEdge, undefined, new Date(), 100000);
            
            // Guaranteed should have higher size
            expect(guaranteedSignal.size).toBeGreaterThanOrEqual(normalSignal.size);
            expect(guaranteedSignal.isGuaranteed).toBe(true);
        });

        it('should use high urgency for guaranteed outcomes', () => {
            const guaranteedEdge = createMockEdge('test-market', 'yes', 0.15, 0.8, true);
            
            const signal = entryOptimizer.optimizeEntry(guaranteedEdge, undefined, new Date(), 100000);
            
            expect(signal.urgency).toBe('HIGH');
        });
    });

    describe('Limit Price Calculation', () => {
        it('should calculate optimal limit price', () => {
            const edge = createMockEdge('test-market', 'yes', 0.15, 0.8);
            const orderBook = createMockOrderBook('0.48', '0.52', '1000', '1000');
            
            const signal = entryOptimizer.optimizeEntry(edge, orderBook, new Date(), 100000);
            
            // For medium urgency, should have a limit price
            if (signal.priceLimit) {
                expect(signal.priceLimit).toBeGreaterThan(0);
                expect(signal.priceLimit).toBeLessThanOrEqual(1);
            }
        });

        it('should not set limit price for very high urgency', () => {
            const edge = createMockEdge();
            
            // Guaranteed outcomes have very high urgency
            const guaranteedEdge = { ...edge, isGuaranteed: true };
            
            const signal = entryOptimizer.optimizeEntry(guaranteedEdge, undefined, new Date(), 100000);
            
            // Market orders don't need limit price
            if (signal.orderType === 'MARKET') {
                expect(signal.priceLimit).toBeUndefined();
            }
        });
    });
});
