/**
 * Market Impact Model Test Suite
 * 
 * Tests for the square-root law of market impact:
 * impact = k * sqrt(order_size / daily_volume)
 * 
 * Features tested:
 * - Square-root law formula accuracy
 * - Impact estimation for different order sizes
 * - Optimal order sizing
 * - Impact decay over time
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MarketImpactModel, LiquidityProfile } from '../strategy/market-impact.js';

// Mock the logger to avoid console noise during tests
jest.mock('../logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

describe('MarketImpactModel', () => {
    let marketImpactModel: MarketImpactModel;

    beforeEach(() => {
        marketImpactModel = new MarketImpactModel();
    });

    describe('Square-Root Law Formula', () => {
        it('should calculate impact using square-root law: impact = k * sqrt(order_size / daily_volume)', () => {
            const orderSize = 1000; // $1000
            const dailyVolume = 100000; // $100k daily volume
            const liquidityScore = 0.5; // Medium liquidity

            const impact = marketImpactModel.estimateImpact(orderSize, dailyVolume, liquidityScore);

            // For medium liquidity, k = 0.8
            // impact = 0.8 * sqrt(1000 / 100000) = 0.8 * sqrt(0.01) = 0.8 * 0.1 = 0.08
            const expectedImpact = 0.8 * Math.sqrt(orderSize / dailyVolume);
            
            expect(impact).toBeCloseTo(expectedImpact, 4);
        });

        it('should use different k values based on liquidity score', () => {
            const orderSize = 5000;
            const dailyVolume = 100000;

            // Low liquidity (k = 1.5)
            const lowLiqImpact = marketImpactModel.estimateImpact(orderSize, dailyVolume, 0.2);
            
            // Medium liquidity (k = 0.8)
            const medLiqImpact = marketImpactModel.estimateImpact(orderSize, dailyVolume, 0.5);
            
            // High liquidity (k = 0.3)
            const highLiqImpact = marketImpactModel.estimateImpact(orderSize, dailyVolume, 0.8);

            // Higher liquidity = lower impact
            expect(highLiqImpact).toBeLessThan(medLiqImpact);
            expect(medLiqImpact).toBeLessThan(lowLiqImpact);
        });

        it('should return default 5% impact for unknown volume', () => {
            const impact = marketImpactModel.estimateImpact(1000, 0, 0.5);
            expect(impact).toBe(0.05);
        });

        it('should cap impact at 20% maximum', () => {
            // Very large order relative to volume
            const impact = marketImpactModel.estimateImpact(100000, 1000, 0.2);
            expect(impact).toBeLessThanOrEqual(0.20);
        });

        it('should scale with square root of participation rate', () => {
            const dailyVolume = 100000;
            const liquidityScore = 0.5;

            // Double the order size should increase impact by sqrt(2), not 2x
            const impact1 = marketImpactModel.estimateImpact(1000, dailyVolume, liquidityScore);
            const impact2 = marketImpactModel.estimateImpact(2000, dailyVolume, liquidityScore);

            const ratio = impact2 / impact1;
            expect(ratio).toBeCloseTo(Math.sqrt(2), 2);
        });
    });

    describe('Impact Estimation for Different Order Sizes', () => {
        it('should estimate low impact for small orders (< 1% of daily volume)', () => {
            const dailyVolume = 100000;
            const smallOrder = 500; // 0.5% of daily volume

            const impact = marketImpactModel.estimateImpact(smallOrder, dailyVolume, 0.7);
            
            // Should be less than 8% (allowing for higher k values)
            expect(impact).toBeLessThan(0.08);
        });

        it('should estimate moderate impact for medium orders (1-5% of daily volume)', () => {
            const dailyVolume = 100000;
            const mediumOrder = 3000; // 3% of daily volume

            const impact = marketImpactModel.estimateImpact(mediumOrder, dailyVolume, 0.5);
            
            // Should be between 1% and 15% (allowing for higher k values)
            expect(impact).toBeGreaterThan(0.01);
            expect(impact).toBeLessThan(0.15);
        });

        it('should estimate high impact for large orders (> 10% of daily volume)', () => {
            const dailyVolume = 100000;
            const largeOrder = 15000; // 15% of daily volume

            const impact = marketImpactModel.estimateImpact(largeOrder, dailyVolume, 0.3);
            
            // Should be greater than 5%
            expect(impact).toBeGreaterThan(0.05);
        });

        it('should provide complete impact estimate with all components', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const estimate = marketImpactModel.estimateCompleteImpact(2000, liquidity);

            expect(estimate).toHaveProperty('immediateImpact');
            expect(estimate).toHaveProperty('decayedImpact');
            expect(estimate).toHaveProperty('totalCost');
            expect(estimate).toHaveProperty('slippageEstimate');
            expect(estimate).toHaveProperty('recommendedMaxSize');
            expect(estimate).toHaveProperty('optimalChunkSize');

            // All values should be positive
            expect(estimate.immediateImpact).toBeGreaterThanOrEqual(0);
            expect(estimate.totalCost).toBeGreaterThanOrEqual(0);
            expect(estimate.recommendedMaxSize).toBeGreaterThan(0);
            expect(estimate.optimalChunkSize).toBeGreaterThan(0);
        });
    });

    describe('Optimal Order Sizing', () => {
        it('should calculate optimal order size for target impact', () => {
            const desiredSize = 5000;
            const dailyVolume = 100000;
            const liquidityScore = 0.5;

            const optimalSize = marketImpactModel.calculateOptimalOrderSize(
                desiredSize,
                dailyVolume,
                liquidityScore
            );

            // Optimal size should not exceed desired size
            expect(optimalSize).toBeLessThanOrEqual(desiredSize);
            expect(optimalSize).toBeGreaterThan(0);
        });

        it('should recommend smaller chunks for large orders', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 10000,
                askDepth: 10000,
                spread: 0.01,
                volatility: 0.03,
            };

            const largeOrder = 20000; // 20% of daily volume
            const chunkingPlan = marketImpactModel.createChunkingPlan(largeOrder, liquidity, 30000);

            // Should create multiple chunks
            expect(chunkingPlan.chunks.length).toBeGreaterThan(1);
            
            // Each chunk should be smaller than total
            for (const chunk of chunkingPlan.chunks) {
                expect(chunk.size).toBeLessThan(largeOrder);
                expect(chunk.expectedImpact).toBeGreaterThan(0);
            }

            // Sum of chunks should equal total
            const totalChunked = chunkingPlan.chunks.reduce((sum, c) => sum + c.size, 0);
            expect(totalChunked).toBeCloseTo(largeOrder, 0);
        });

        it('should not chunk small orders', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 10000,
                askDepth: 10000,
                spread: 0.01,
                volatility: 0.03,
            };

            const smallOrder = 100; // Small order
            const chunkingPlan = marketImpactModel.createChunkingPlan(smallOrder, liquidity);

            // Should be a single chunk
            expect(chunkingPlan.chunks.length).toBe(1);
            expect(chunkingPlan.chunks[0].size).toBeCloseTo(smallOrder, 0);
        });

        it('should provide recommended maximum order size', () => {
            const dailyVolume = 100000;
            
            const maxSizeLowLiq = marketImpactModel.getRecommendedMaxOrderSize(dailyVolume, 0.2);
            const maxSizeHighLiq = marketImpactModel.getRecommendedMaxOrderSize(dailyVolume, 0.8);

            // Higher liquidity = larger recommended size
            expect(maxSizeHighLiq).toBeGreaterThan(maxSizeLowLiq);
        });
    });

    describe('Impact Decay Over Time', () => {
        it('should calculate decayed impact using exponential decay', () => {
            const initialImpact = 0.10; // 10% initial impact
            const timeMs = 60000; // 1 minute

            const decayedImpact = marketImpactModel.calculateDecayedImpact(initialImpact, timeMs);

            // After 1 minute (half-life), impact should be halved
            expect(decayedImpact).toBeCloseTo(initialImpact * 0.5, 2);
        });

        it('should have minimal decay for short time periods', () => {
            const initialImpact = 0.10;
            const timeMs = 1000; // 1 second

            const decayedImpact = marketImpactModel.calculateDecayedImpact(initialImpact, timeMs);

            // Should still be close to initial impact
            expect(decayedImpact).toBeGreaterThan(initialImpact * 0.95);
        });

        it('should have significant decay after multiple half-lives', () => {
            const initialImpact = 0.10;
            const timeMs = 5 * 60000; // 5 minutes = 5 half-lives

            const decayedImpact = marketImpactModel.calculateDecayedImpact(initialImpact, timeMs);

            // After 5 half-lives, impact should be ~3% of initial
            expect(decayedImpact).toBeCloseTo(initialImpact * Math.pow(0.5, 5), 3);
        });

        it('should estimate total cost including decay', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const estimate = marketImpactModel.estimateCompleteImpact(3000, liquidity);

            // Decayed impact should be less than immediate impact
            expect(estimate.decayedImpact).toBeLessThan(estimate.immediateImpact);
            
            // Total cost should include immediate impact, spread, and slippage
            expect(estimate.totalCost).toBeGreaterThanOrEqual(estimate.immediateImpact);
        });
    });

    describe('Slippage Estimation', () => {
        it('should estimate higher slippage for larger orders', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const slippageSmall = marketImpactModel.estimateSlippage(500, liquidity);
            const slippageLarge = marketImpactModel.estimateSlippage(5000, liquidity);

            expect(slippageLarge).toBeGreaterThan(slippageSmall);
        });

        it('should cap slippage at 10%', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 1000, // Very low volume
                averageTradeSize: 10,
                bidDepth: 100,
                askDepth: 100,
                spread: 0.05,
                volatility: 0.5, // High volatility
            };

            const slippage = marketImpactModel.estimateSlippage(10000, liquidity);
            expect(slippage).toBeLessThanOrEqual(0.10);
        });
    });

    describe('Excessive Impact Detection', () => {
        it('should detect excessive impact for large orders', () => {
            const dailyVolume = 10000; // Low volume market
            const largeOrder = 5000; // 50% of daily volume

            const isExcessive = marketImpactModel.isExcessiveImpact(
                largeOrder,
                dailyVolume,
                0.3
            );

            expect(isExcessive).toBe(true);
        });

        it('should not flag reasonable order sizes as excessive', () => {
            const dailyVolume = 100000;
            const reasonableOrder = 100; // 0.1% of daily volume

            const isExcessive = marketImpactModel.isExcessiveImpact(
                reasonableOrder,
                dailyVolume,
                0.8 // High liquidity
            );

            expect(isExcessive).toBe(false);
        });
    });

    describe('Total Execution Cost', () => {
        it('should calculate total execution cost for buy orders', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const cost = marketImpactModel.estimateTotalExecutionCost(2000, 'buy', liquidity);

            expect(cost.marketImpact).toBeGreaterThan(0);
            expect(cost.spreadCost).toBeGreaterThan(0);
            expect(cost.slippage).toBeGreaterThan(0);
            expect(cost.totalCost).toBeGreaterThan(0);
            
            // Cost basis for buy should be > 1 (premium paid)
            expect(cost.costBasis).toBeGreaterThan(1);
        });

        it('should calculate total execution cost for sell orders', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const cost = marketImpactModel.estimateTotalExecutionCost(2000, 'sell', liquidity);

            // Cost basis for sell should be < 1 (discount received)
            expect(cost.costBasis).toBeLessThan(1);
        });

        it('should sum all cost components correctly', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 5000,
                askDepth: 5000,
                spread: 0.02,
                volatility: 0.05,
            };

            const cost = marketImpactModel.estimateTotalExecutionCost(2000, 'buy', liquidity);

            const expectedTotal = cost.marketImpact + cost.spreadCost + cost.slippage;
            expect(cost.totalCost).toBeCloseTo(expectedTotal, 4);
        });
    });

    describe('Chunking Plan', () => {
        it('should distribute chunks over specified time window', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 10000,
                askDepth: 10000,
                spread: 0.01,
                volatility: 0.03,
            };

            const maxTimeMs = 30000; // 30 seconds
            const plan = marketImpactModel.createChunkingPlan(10000, liquidity, maxTimeMs);

            if (plan.chunks.length > 1) {
                // Last chunk should be within the time window
                const lastChunk = plan.chunks[plan.chunks.length - 1];
                expect(lastChunk.delayMs).toBeLessThanOrEqual(maxTimeMs);
                
                // Execution time should match the last chunk's delay
                expect(plan.executionTimeMs).toBe(lastChunk.delayMs);
            }
        });

        it('should account for impact decay between chunks', () => {
            const liquidity: LiquidityProfile = {
                dailyVolume: 100000,
                averageTradeSize: 500,
                bidDepth: 10000,
                askDepth: 10000,
                spread: 0.01,
                volatility: 0.03,
            };

            const plan = marketImpactModel.createChunkingPlan(15000, liquidity, 30000);

            // Total expected impact should account for decay
            // Later chunks have less impact due to decay
            expect(plan.totalExpectedImpact).toBeGreaterThan(0);
            
            // Sum of individual impacts would be higher than decayed total
            const sumIndividualImpacts = plan.chunks.reduce((sum, c) => sum + c.expectedImpact, 0);
            expect(plan.totalExpectedImpact).toBeLessThanOrEqual(sumIndividualImpacts);
        });
    });
});
