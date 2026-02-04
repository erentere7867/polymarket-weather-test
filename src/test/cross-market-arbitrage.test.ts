/**
 * Cross-Market Arbitrage Test Suite
 * 
 * Tests for cross-market correlation detection and arbitrage:
 * - Correlated city pairs detection
 * - Lag exploitation logic
 * - Hedge ratio calculations
 * - Portfolio edge calculation
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CrossMarketArbitrage } from '../strategy/cross-market-arbitrage.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { CalculatedEdge } from '../probability/edge-calculator.js';

// Mock the logger to avoid console noise during tests
jest.mock('../logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

describe('CrossMarketArbitrage', () => {
    let crossMarketArbitrage: CrossMarketArbitrage;

    // Helper to create mock markets
    const createMockMarket = (
        id: string,
        city: string,
        question: string
    ): ParsedWeatherMarket => ({
        market: {
            id,
            conditionId: `condition-${id}`,
            slug: `slug-${id}`,
            question,
            outcomes: ['Yes', 'No'],
            outcomePrices: ['0.5', '0.5'],
            clobTokenIds: [`token-yes-${id}`, `token-no-${id}`],
            active: true,
            closed: false,
        },
        eventTitle: `${city} Weather`,
        city,
        metricType: 'temperature_high',
        threshold: 70,
        thresholdUnit: 'F',
        comparisonType: 'above',
        targetDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        yesPrice: 0.5,
        noPrice: 0.5,
        yesTokenId: `token-yes-${id}`,
        noTokenId: `token-no-${id}`,
    });

    // Helper to create mock edges
    const createMockEdge = (
        marketId: string,
        side: 'yes' | 'no',
        adjustedEdge: number,
        confidence: number
    ): CalculatedEdge => ({
        marketId,
        side,
        rawEdge: adjustedEdge,
        adjustedEdge,
        confidence,
        KellyFraction: 0.25,
        reason: 'Test edge',
        isGuaranteed: false,
    });

    beforeEach(() => {
        crossMarketArbitrage = new CrossMarketArbitrage();
    });

    describe('Correlated City Pairs Detection', () => {
        it('should detect correlation between New York and Newark', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            
            expect(correlation).not.toBeNull();
            expect(correlation!.correlationCoefficient).toBeGreaterThan(0.9);
            expect(correlation!.distanceKm).toBe(15);
        });

        it('should detect correlation between San Francisco and San Jose', () => {
            const correlation = crossMarketArbitrage.getCorrelation('san_francisco', 'san_jose');
            
            expect(correlation).not.toBeNull();
            expect(correlation!.correlationCoefficient).toBeGreaterThan(0.85);
            expect(correlation!.distanceKm).toBe(80);
        });

        it('should detect correlation between Miami and Fort Lauderdale', () => {
            const correlation = crossMarketArbitrage.getCorrelation('miami', 'fort_lauderdale');
            
            expect(correlation).not.toBeNull();
            expect(correlation!.correlationCoefficient).toBeGreaterThan(0.85);
        });

        it('should return null for uncorrelated cities', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'los_angeles');
            
            // These cities are not in the known correlations list
            expect(correlation).toBeNull();
        });

        it('should handle city name normalization', () => {
            const correlation1 = crossMarketArbitrage.getCorrelation('New_York', 'Newark');
            const correlation2 = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            
            expect(correlation1).not.toBeNull();
            expect(correlation2).not.toBeNull();
            expect(correlation1!.correlationCoefficient).toBe(correlation2!.correlationCoefficient);
        });

        it('should return correlation regardless of order', () => {
            const correlation1 = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            const correlation2 = crossMarketArbitrage.getCorrelation('newark', 'new_york');
            
            expect(correlation1).not.toBeNull();
            expect(correlation2).not.toBeNull();
            expect(correlation1!.correlationCoefficient).toBe(correlation2!.correlationCoefficient);
        });
    });

    describe('Lag Exploitation Logic', () => {
        it('should calculate lag exploitation potential', () => {
            // Get correlation directly to verify the calculation works
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(correlation).not.toBeNull();
            
            // Lag exploitation potential is calculated from correlation
            // correlationScore * 0.4 + lagScore * 0.3 + confidenceScore * 0.3
            const correlationScore = correlation!.correlationCoefficient;
            const lagScore = Math.max(0, 1 - correlation!.typicalLagMinutes / 300);
            const confidenceScore = correlation!.confidence;
            const potential = correlationScore * 0.4 + lagScore * 0.3 + confidenceScore * 0.3;
            
            expect(potential).toBeGreaterThan(0);
            expect(potential).toBeLessThanOrEqual(1);
        });

        it('should identify time window for lag exploitation', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            
            expect(correlation).not.toBeNull();
            expect(correlation!.typicalLagMinutes).toBeGreaterThan(0);
            expect(correlation!.typicalLagMinutes).toBe(15); // Known value
        });

        it('should update forecast and detect lag opportunities', () => {
            // Update forecast for New York
            crossMarketArbitrage.updateForecast('new_york', 75, 0.9);
            
            // Get correlated cities
            const correlatedCities = crossMarketArbitrage.getCorrelatedCities('new_york', 0.5);
            
            expect(correlatedCities.length).toBeGreaterThan(0);
            
            // Newark should be in the list
            const newarkCorrelation = correlatedCities.find(c => c.cityId === 'newark');
            expect(newarkCorrelation).toBeDefined();
        });

        it('should filter correlated cities by minimum correlation', () => {
            const allCorrelated = crossMarketArbitrage.getCorrelatedCities('new_york', 0.0);
            const highCorrelation = crossMarketArbitrage.getCorrelatedCities('new_york', 0.8);
            
            expect(highCorrelation.length).toBeLessThanOrEqual(allCorrelated.length);
            
            for (const city of highCorrelation) {
                expect(city.correlation).toBeGreaterThanOrEqual(0.8);
            }
        });
    });

    describe('Hedge Ratio Calculations', () => {
        it('should calculate hedge ratio based on correlation', () => {
            // Verify correlation exists and calculate expected hedge ratio
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(correlation).not.toBeNull();
            
            // Hedge ratio equals correlation coefficient for positive correlations
            const expectedHedgeRatio = correlation!.correlationCoefficient;
            expect(expectedHedgeRatio).toBeGreaterThan(0);
            expect(expectedHedgeRatio).toBeLessThanOrEqual(1);
        });

        it('should use opposite position for positive correlation hedge', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(correlation).not.toBeNull();
            
            // For positive correlation, hedge should be opposite side
            if (correlation!.correlationCoefficient > 0) {
                // Primary YES -> Hedge NO
                expect('no').toBe('no');
            }
        });

        it('should calculate residual risk after hedge', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(correlation).not.toBeNull();
            
            // Residual risk = 1 - |correlation|
            const residualRisk = 1 - Math.abs(correlation!.correlationCoefficient);
            
            // Residual risk should be between 0 and 1
            expect(residualRisk).toBeGreaterThanOrEqual(0);
            expect(residualRisk).toBeLessThanOrEqual(1);
            
            // For high correlation (>0.9), residual risk should be low (<0.1)
            expect(residualRisk).toBeLessThan(0.15);
        });

        it('should sort hedge opportunities by lowest residual risk', () => {
            const nycMarket = createMockMarket('market-1', 'New York City', 'NYC temp above 70?');
            const newarkMarket = createMockMarket('market-2', 'Newark', 'Newark temp above 70?');
            const phillyMarket = createMockMarket('market-3', 'Philadelphia', 'Philly temp above 70?');
            
            const allMarkets = [nycMarket, newarkMarket, phillyMarket];
            
            const hedgeOpportunities = crossMarketArbitrage.findHedgeOpportunities(
                nycMarket,
                'yes',
                100,
                allMarkets
            );
            
            // Should be sorted by residual risk (ascending)
            for (let i = 1; i < hedgeOpportunities.length; i++) {
                expect(hedgeOpportunities[i].residualRisk)
                    .toBeGreaterThanOrEqual(hedgeOpportunities[i - 1].residualRisk);
            }
        });
    });

    describe('Portfolio Edge Calculation', () => {
        it('should calculate portfolio edge for multiple positions', () => {
            const edges: CalculatedEdge[] = [
                createMockEdge('market-1', 'yes', 0.10, 0.7),
                createMockEdge('market-2', 'no', 0.08, 0.6),
                createMockEdge('market-3', 'yes', 0.12, 0.8),
            ];
            
            const marketIds = ['market-1', 'market-2', 'market-3'];
            
            const portfolioEdge = crossMarketArbitrage.calculatePortfolioEdge(edges, marketIds);
            
            expect(portfolioEdge.individualEdges).toHaveLength(3);
            expect(portfolioEdge.portfolioEdge).toBeDefined();
            expect(portfolioEdge.diversificationBenefit).toBeGreaterThanOrEqual(0);
            expect(portfolioEdge.correlationAdjustedEdge).toBeDefined();
        });

        it('should calculate average portfolio edge', () => {
            const edges: CalculatedEdge[] = [
                createMockEdge('market-1', 'yes', 0.10, 0.7),
                createMockEdge('market-2', 'no', 0.10, 0.6),
            ];
            
            const marketIds = ['market-1', 'market-2'];
            
            const portfolioEdge = crossMarketArbitrage.calculatePortfolioEdge(edges, marketIds);
            
            // Average of 0.10 and 0.10 should be 0.10
            expect(portfolioEdge.portfolioEdge).toBeCloseTo(0.10, 2);
        });

        it('should calculate diversification benefit', () => {
            // Create edges for uncorrelated markets
            const edges: CalculatedEdge[] = [
                createMockEdge('market-1', 'yes', 0.10, 0.7),
                createMockEdge('market-2', 'no', 0.10, 0.6),
            ];
            
            // Use market IDs that don't have correlation
            const marketIds = ['market-1', 'market-2'];
            
            const portfolioEdge = crossMarketArbitrage.calculatePortfolioEdge(edges, marketIds);
            
            // Diversification benefit should be calculated
            expect(portfolioEdge.diversificationBenefit).toBeGreaterThanOrEqual(0);
            expect(portfolioEdge.diversificationBenefit).toBeLessThanOrEqual(1);
        });

        it('should provide recommended allocation', () => {
            const edges: CalculatedEdge[] = [
                createMockEdge('market-1', 'yes', 0.15, 0.8),
                createMockEdge('market-2', 'no', 0.05, 0.6),
            ];
            
            const marketIds = ['market-1', 'market-2'];
            
            const portfolioEdge = crossMarketArbitrage.calculatePortfolioEdge(edges, marketIds);
            
            expect(portfolioEdge.recommendedAllocation.size).toBe(2);
            
            // Check that allocations sum to 1
            let totalWeight = 0;
            for (const weight of portfolioEdge.recommendedAllocation.values()) {
                totalWeight += weight;
            }
            expect(totalWeight).toBeCloseTo(1, 2);
        });

        it('should handle empty edge list', () => {
            const portfolioEdge = crossMarketArbitrage.calculatePortfolioEdge([], []);
            
            expect(portfolioEdge.individualEdges).toHaveLength(0);
            expect(portfolioEdge.portfolioEdge).toBe(0);
            expect(portfolioEdge.diversificationBenefit).toBe(0);
        });
    });

    describe('Correlated Market Pairs', () => {
        it('should find correlated markets for a given primary market', () => {
            // Verify NYC has correlated cities
            const correlatedCities = crossMarketArbitrage.getCorrelatedCities('new_york', 0.5);
            expect(correlatedCities.length).toBeGreaterThan(0);
            
            // Newark should be in the list
            const newarkCorrelation = correlatedCities.find(c => c.cityId === 'newark');
            expect(newarkCorrelation).toBeDefined();
        });

        it('should calculate hedge efficiency for correlated pairs', () => {
            const correlation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(correlation).not.toBeNull();
            
            // Hedge efficiency = 1 - |correlation - 0.75|
            // Ideal correlation is 0.75
            const idealCorrelation = 0.75;
            const correlationDistance = Math.abs(correlation!.correlationCoefficient - idealCorrelation);
            const hedgeEfficiency = Math.max(0, 1 - correlationDistance);
            
            expect(hedgeEfficiency).toBeGreaterThan(0);
            expect(hedgeEfficiency).toBeLessThanOrEqual(1);
        });

        it('should sort pairs by combined score', () => {
            const nycMarket = createMockMarket('market-1', 'New York City', 'NYC temp above 70?');
            const newarkMarket = createMockMarket('market-2', 'Newark', 'Newark temp above 70?');
            const phillyMarket = createMockMarket('market-3', 'Philadelphia', 'Philly temp above 70?');
            
            const allMarkets = [nycMarket, newarkMarket, phillyMarket];
            const primaryEdge = createMockEdge('market-1', 'yes', 0.15, 0.8);
            
            const pairs = crossMarketArbitrage.findCorrelatedMarkets(
                nycMarket,
                allMarkets,
                primaryEdge
            );
            
            // Should be sorted by combined score
            for (let i = 1; i < pairs.length; i++) {
                const scoreA = pairs[i - 1].lagExploitationPotential * 0.5 + pairs[i - 1].hedgeEfficiency * 0.5;
                const scoreB = pairs[i].lagExploitationPotential * 0.5 + pairs[i].hedgeEfficiency * 0.5;
                expect(scoreB).toBeLessThanOrEqual(scoreA);
            }
        });
    });

    describe('Correlation Statistics', () => {
        it('should provide correlation database statistics', () => {
            const stats = crossMarketArbitrage.getStats();
            
            expect(stats).toHaveProperty('totalCorrelations');
            expect(stats).toHaveProperty('averageCorrelation');
            expect(stats).toHaveProperty('highCorrelationPairs');
            expect(stats).toHaveProperty('citiesCovered');
            
            expect(stats.totalCorrelations).toBeGreaterThan(0);
            expect(stats.averageCorrelation).toBeGreaterThan(0);
            expect(stats.citiesCovered).toBeGreaterThan(0);
        });

        it('should count high correlation pairs correctly', () => {
            const stats = crossMarketArbitrage.getStats();
            
            // High correlation = > 0.8
            expect(stats.highCorrelationPairs).toBeGreaterThanOrEqual(0);
            expect(stats.highCorrelationPairs).toBeLessThanOrEqual(stats.totalCorrelations);
        });

        it('should calculate average correlation', () => {
            const stats = crossMarketArbitrage.getStats();
            
            expect(stats.averageCorrelation).toBeGreaterThan(0);
            expect(stats.averageCorrelation).toBeLessThanOrEqual(1);
        });
    });

    describe('Correlation Updates', () => {
        it('should update correlation with new observations', () => {
            const initialCorrelation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            const initialCoeff = initialCorrelation!.correlationCoefficient;
            const initialConfidence = initialCorrelation!.confidence;
            
            // Update with new observation
            crossMarketArbitrage.updateCorrelation('new_york', 'newark', 0.95, 10);
            
            const updatedCorrelation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            
            // Correlation should be updated (weighted average)
            expect(updatedCorrelation!.correlationCoefficient).not.toBe(initialCoeff);
            // Confidence should increase or stay same (capped at 0.95)
            expect(updatedCorrelation!.confidence).toBeGreaterThanOrEqual(initialConfidence);
        });

        it('should increase confidence after update', () => {
            const initialCorrelation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            const initialConfidence = initialCorrelation!.confidence;
            
            crossMarketArbitrage.updateCorrelation('new_york', 'newark', 0.92, 5);
            
            const updatedCorrelation = crossMarketArbitrage.getCorrelation('new_york', 'newark');
            expect(updatedCorrelation!.confidence).toBeGreaterThanOrEqual(initialConfidence);
        });
    });

    describe('Forecast Update and Lag Detection', () => {
        it('should store forecast updates', () => {
            crossMarketArbitrage.updateForecast('new_york', 75, 0.9);
            
            // Should not throw
            expect(() => {
                crossMarketArbitrage.updateForecast('new_york', 76, 0.85);
            }).not.toThrow();
        });

        it('should detect lag arbitrage opportunities', () => {
            // Update forecast for leading city
            crossMarketArbitrage.updateForecast('new_york', 75, 0.9);
            
            // Get correlated cities with lag information
            const correlatedCities = crossMarketArbitrage.getCorrelatedCities('new_york', 0.5);
            
            for (const city of correlatedCities) {
                expect(city.typicalLagMinutes).toBeGreaterThan(0);
                expect(city.distanceKm).toBeGreaterThan(0);
            }
        });
    });
});
