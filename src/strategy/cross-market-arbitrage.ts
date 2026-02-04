/**
 * Cross-Market Correlation & Arbitrage
 * 
 * Detects and exploits correlations between related weather markets:
 * - Nearby cities have correlated weather patterns
 * - Exploit lag between correlated markets
 * - Portfolio-level edge calculation
 * - Hedge opportunities across markets
 */

import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { CalculatedEdge } from '../probability/edge-calculator.js';
import { logger } from '../logger.js';

/**
 * Geographic correlation between cities
 */
export interface CityCorrelation {
    cityA: string;
    cityB: string;
    correlationCoefficient: number;  // -1 to 1
    distanceKm: number;
    typicalLagMinutes: number;       // How much cityB lags cityA
    confidence: number;              // 0-1 confidence in correlation
    lastUpdated: Date;
}

/**
 * Correlated market pair
 */
export interface CorrelatedMarketPair {
    primaryMarket: ParsedWeatherMarket;
    correlatedMarket: ParsedWeatherMarket;
    correlation: CityCorrelation;
    primaryEdge: CalculatedEdge;
    correlatedEdge: CalculatedEdge;
    lagExploitationPotential: number;  // 0-1 score
    hedgeEfficiency: number;           // 0-1 score
}

/**
 * Portfolio edge calculation
 */
export interface PortfolioEdge {
    individualEdges: CalculatedEdge[];
    portfolioEdge: number;
    diversificationBenefit: number;    // Risk reduction from diversification
    correlationAdjustedEdge: number;   // Edge adjusted for correlations
    recommendedAllocation: Map<string, number>;  // marketId -> position size
}

/**
 * Lag arbitrage opportunity
 */
export interface LagArbitrageOpportunity {
    leadingMarket: ParsedWeatherMarket;
    laggingMarket: ParsedWeatherMarket;
    forecastChange: number;
    expectedLaggingChange: number;
    timeWindowMs: number;              // How long to exploit
    confidence: number;
    recommendedAction: 'BUY_LEADING' | 'BUY_LAGGING' | 'HEDGE_PAIR';
}

/**
 * Hedge opportunity across markets
 */
export interface HedgeOpportunity {
    primaryPosition: {
        marketId: string;
        side: 'yes' | 'no';
        size: number;
    };
    hedgePosition: {
        marketId: string;
        side: 'yes' | 'no';
        size: number;
    };
    correlation: number;
    hedgeRatio: number;                // Size ratio for optimal hedge
    residualRisk: number;              // Risk remaining after hedge
    expectedPnL: number;
}

/**
 * Known city correlations (can be expanded with historical analysis)
 */
const KNOWN_CITY_CORRELATIONS: CityCorrelation[] = [
    // New York Metro Area
    { cityA: 'new_york', cityB: 'newark', correlationCoefficient: 0.92, distanceKm: 15, typicalLagMinutes: 15, confidence: 0.85, lastUpdated: new Date() },
    { cityA: 'new_york', cityB: 'philadelphia', correlationCoefficient: 0.78, distanceKm: 130, typicalLagMinutes: 90, confidence: 0.75, lastUpdated: new Date() },
    
    // California Coast
    { cityA: 'los_angeles', cityB: 'san_diego', correlationCoefficient: 0.72, distanceKm: 180, typicalLagMinutes: 120, confidence: 0.70, lastUpdated: new Date() },
    { cityA: 'san_francisco', cityB: 'san_jose', correlationCoefficient: 0.88, distanceKm: 80, typicalLagMinutes: 45, confidence: 0.80, lastUpdated: new Date() },
    
    // Texas Triangle
    { cityA: 'houston', cityB: 'dallas', correlationCoefficient: 0.65, distanceKm: 360, typicalLagMinutes: 180, confidence: 0.60, lastUpdated: new Date() },
    { cityA: 'houston', cityB: 'san_antonio', correlationCoefficient: 0.68, distanceKm: 320, typicalLagMinutes: 150, confidence: 0.62, lastUpdated: new Date() },
    
    // Midwest
    { cityA: 'chicago', cityB: 'milwaukee', correlationCoefficient: 0.85, distanceKm: 140, typicalLagMinutes: 60, confidence: 0.78, lastUpdated: new Date() },
    { cityA: 'chicago', cityB: 'detroit', correlationCoefficient: 0.70, distanceKm: 380, typicalLagMinutes: 180, confidence: 0.65, lastUpdated: new Date() },
    
    // Florida
    { cityA: 'miami', cityB: 'fort_lauderdale', correlationCoefficient: 0.90, distanceKm: 45, typicalLagMinutes: 30, confidence: 0.82, lastUpdated: new Date() },
    { cityA: 'miami', cityB: 'orlando', correlationCoefficient: 0.60, distanceKm: 380, typicalLagMinutes: 200, confidence: 0.55, lastUpdated: new Date() },
    
    // Pacific Northwest
    { cityA: 'seattle', cityB: 'portland', correlationCoefficient: 0.82, distanceKm: 280, typicalLagMinutes: 120, confidence: 0.75, lastUpdated: new Date() },
    
    // Northeast Corridor
    { cityA: 'boston', cityB: 'providence', correlationCoefficient: 0.87, distanceKm: 80, typicalLagMinutes: 45, confidence: 0.80, lastUpdated: new Date() },
    { cityA: 'boston', cityB: 'new_york', correlationCoefficient: 0.72, distanceKm: 350, typicalLagMinutes: 180, confidence: 0.68, lastUpdated: new Date() },
];

export class CrossMarketArbitrage {
    private correlations: Map<string, CityCorrelation> = new Map();
    private activeForecasts: Map<string, {
        forecastValue: number;
        timestamp: Date;
        confidence: number;
    }> = new Map();
    private lagDetectionWindow: Map<string, Date> = new Map();
    
    // Configuration
    private readonly MIN_CORRELATION_FOR_ARBITRAGE = 0.60;
    private readonly MAX_LAG_MINUTES = 300;  // 5 hours max
    private readonly LAG_EXPLOITATION_THRESHOLD = 0.70;  // Min correlation to exploit lag

    constructor() {
        this.initializeCorrelations();
    }

    /**
     * Initialize correlation database
     */
    private initializeCorrelations(): void {
        for (const corr of KNOWN_CITY_CORRELATIONS) {
            const key = this.getCorrelationKey(corr.cityA, corr.cityB);
            this.correlations.set(key, corr);
        }
        
        logger.info(`[CrossMarketArbitrage] Initialized with ${this.correlations.size} city correlations`);
    }

    /**
     * Get correlation key (sorted for consistency)
     */
    private getCorrelationKey(cityA: string, cityB: string): string {
        const cities = [cityA.toLowerCase(), cityB.toLowerCase()].sort();
        return `${cities[0]}_${cities[1]}`;
    }

    /**
     * Find correlation between two cities
     */
    getCorrelation(cityA: string, cityB: string): CityCorrelation | null {
        const key = this.getCorrelationKey(cityA, cityB);
        return this.correlations.get(key) || null;
    }

    /**
     * Update forecast for a city
     */
    updateForecast(cityId: string, forecastValue: number, confidence: number): void {
        const timestamp = new Date();
        
        this.activeForecasts.set(cityId, {
            forecastValue,
            timestamp,
            confidence
        });
        
        // Check for lag arbitrage opportunities
        this.detectLagArbitrage(cityId, forecastValue, timestamp);
    }

    /**
     * Detect lag arbitrage opportunities when a correlated city updates
     */
    private detectLagArbitrage(
        updatedCityId: string, 
        newValue: number, 
        timestamp: Date
    ): LagArbitrageOpportunity[] {
        const opportunities: LagArbitrageOpportunity[] = [];
        
        for (const [key, correlation] of this.correlations.entries()) {
            // Check if this correlation involves the updated city
            const isCityA = correlation.cityA === updatedCityId;
            const isCityB = correlation.cityB === updatedCityId;
            
            if (!isCityA && !isCityB) continue;
            
            // Only exploit strong correlations
            if (correlation.correlationCoefficient < this.LAG_EXPLOITATION_THRESHOLD) continue;
            
            // Determine which city is lagging
            const laggingCityId = isCityA ? correlation.cityB : correlation.cityA;
            
            // Check if we have forecast data for the lagging city
            const laggingForecast = this.activeForecasts.get(laggingCityId);
            if (!laggingForecast) continue;
            
            // Calculate expected change in lagging city
            const previousValue = this.getPreviousForecast(updatedCityId);
            if (!previousValue) continue;
            
            const changeAmount = newValue - previousValue;
            const expectedLaggingChange = changeAmount * correlation.correlationCoefficient;
            
            // Calculate confidence based on correlation strength and data freshness
            const timeSinceUpdate = Date.now() - laggingForecast.timestamp.getTime();
            const freshnessFactor = Math.max(0, 1 - timeSinceUpdate / (10 * 60 * 1000));  // 10 min decay
            const confidence = correlation.confidence * freshnessFactor;
            
            // Calculate time window for exploitation
            const timeWindowMs = correlation.typicalLagMinutes * 60 * 1000;
            
            opportunities.push({
                leadingMarket: null as any,  // Will be filled by caller
                laggingMarket: null as any,
                forecastChange: changeAmount,
                expectedLaggingChange,
                timeWindowMs,
                confidence,
                recommendedAction: changeAmount > 0 ? 'BUY_LAGGING' : 'BUY_LEADING'
            });
            
            logger.debug(`[LagArbitrage] Detected opportunity: ${updatedCityId} -> ${laggingCityId}, change=${changeAmount.toFixed(1)}, expected=${expectedLaggingChange.toFixed(1)}, confidence=${(confidence * 100).toFixed(0)}%`);
        }
        
        return opportunities;
    }

    /**
     * Get previous forecast value (simplified - would use historical data)
     */
    private getPreviousForecast(cityId: string): number | null {
        // In a real implementation, this would query historical forecast data
        // For now, return null to indicate we don't have previous data
        return null;
    }

    /**
     * Find correlated market pairs for a given market
     */
    findCorrelatedMarkets(
        primaryMarket: ParsedWeatherMarket,
        allMarkets: ParsedWeatherMarket[],
        primaryEdge: CalculatedEdge
    ): CorrelatedMarketPair[] {
        const pairs: CorrelatedMarketPair[] = [];
        
        if (!primaryMarket.city) return pairs;
        
        const primaryCityId = primaryMarket.city.toLowerCase().replace(/\s+/g, '_');
        
        for (const otherMarket of allMarkets) {
            if (otherMarket.market.id === primaryMarket.market.id) continue;
            if (!otherMarket.city) continue;
            
            const otherCityId = otherMarket.city.toLowerCase().replace(/\s+/g, '_');
            
            const correlation = this.getCorrelation(primaryCityId, otherCityId);
            if (!correlation) continue;
            if (correlation.correlationCoefficient < this.MIN_CORRELATION_FOR_ARBITRAGE) continue;
            
            // Calculate lag exploitation potential
            const lagExploitationPotential = this.calculateLagExploitationPotential(correlation);
            
            // Calculate hedge efficiency
            const hedgeEfficiency = this.calculateHedgeEfficiency(correlation);
            
            pairs.push({
                primaryMarket,
                correlatedMarket: otherMarket,
                correlation,
                primaryEdge,
                correlatedEdge: null as any,  // Would be calculated by caller
                lagExploitationPotential,
                hedgeEfficiency
            });
        }
        
        // Sort by combined score
        pairs.sort((a, b) => {
            const scoreA = a.lagExploitationPotential * 0.5 + a.hedgeEfficiency * 0.5;
            const scoreB = b.lagExploitationPotential * 0.5 + b.hedgeEfficiency * 0.5;
            return scoreB - scoreA;
        });
        
        return pairs;
    }

    /**
     * Calculate lag exploitation potential
     */
    private calculateLagExploitationPotential(correlation: CityCorrelation): number {
        // Higher correlation and reasonable lag = better exploitation
        const correlationScore = correlation.correlationCoefficient;
        const lagScore = Math.max(0, 1 - correlation.typicalLagMinutes / this.MAX_LAG_MINUTES);
        const confidenceScore = correlation.confidence;
        
        return (correlationScore * 0.4 + lagScore * 0.3 + confidenceScore * 0.3);
    }

    /**
     * Calculate hedge efficiency
     */
    private calculateHedgeEfficiency(correlation: CityCorrelation): number {
        // Higher correlation = better hedge
        // But we want some diversification, so not 100% correlation
        const idealCorrelation = 0.75;
        const correlationDistance = Math.abs(correlation.correlationCoefficient - idealCorrelation);
        
        return Math.max(0, 1 - correlationDistance);
    }

    /**
     * Calculate portfolio-level edge for multiple positions
     */
    calculatePortfolioEdge(edges: CalculatedEdge[], marketIds: string[]): PortfolioEdge {
        if (edges.length === 0) {
            return {
                individualEdges: [],
                portfolioEdge: 0,
                diversificationBenefit: 0,
                correlationAdjustedEdge: 0,
                recommendedAllocation: new Map()
            };
        }
        
        // Calculate simple average edge
        const totalEdge = edges.reduce((sum, e) => sum + e.adjustedEdge, 0);
        const portfolioEdge = totalEdge / edges.length;
        
        // Calculate diversification benefit
        // Lower correlation between positions = higher diversification
        let totalCorrelation = 0;
        let correlationCount = 0;
        
        for (let i = 0; i < marketIds.length; i++) {
            for (let j = i + 1; j < marketIds.length; j++) {
                const corr = this.getCorrelation(marketIds[i], marketIds[j]);
                if (corr) {
                    totalCorrelation += corr.correlationCoefficient;
                    correlationCount++;
                }
            }
        }
        
        const avgCorrelation = correlationCount > 0 ? totalCorrelation / correlationCount : 0;
        const diversificationBenefit = Math.max(0, 1 - avgCorrelation);
        
        // Adjust edge for correlations
        // Diversified portfolio gets a boost, concentrated gets a penalty
        const correlationAdjustedEdge = portfolioEdge * (1 + diversificationBenefit * 0.2);
        
        // Calculate recommended allocation
        const allocation = this.calculateOptimalAllocation(edges, marketIds);
        
        return {
            individualEdges: edges,
            portfolioEdge,
            diversificationBenefit,
            correlationAdjustedEdge,
            recommendedAllocation: allocation
        };
    }

    /**
     * Calculate optimal position allocation using correlation-adjusted Kelly
     */
    private calculateOptimalAllocation(edges: CalculatedEdge[], marketIds: string[]): Map<string, number> {
        const allocation = new Map<string, number>();
        
        // Simple approach: weight by edge, adjust for correlations
        const totalEdge = edges.reduce((sum, e) => sum + e.adjustedEdge, 0);
        
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const marketId = edge.marketId;
            
            // Base allocation by edge size
            let baseWeight = totalEdge > 0 ? edge.adjustedEdge / totalEdge : 1 / edges.length;
            
            // Adjust for correlations with other positions
            let correlationPenalty = 0;
            for (let j = 0; j < marketIds.length; j++) {
                if (i === j) continue;
                
                const corr = this.getCorrelation(marketIds[i], marketIds[j]);
                if (corr) {
                    correlationPenalty += corr.correlationCoefficient * 0.1;  // 10% penalty per correlation
                }
            }
            
            const adjustedWeight = baseWeight * (1 - correlationPenalty);
            allocation.set(marketId, Math.max(0.05, adjustedWeight));  // Min 5% allocation
        }
        
        // Normalize to sum to 1
        let totalWeight = 0;
        for (const weight of allocation.values()) {
            totalWeight += weight;
        }
        
        for (const [marketId, weight] of allocation.entries()) {
            allocation.set(marketId, weight / totalWeight);
        }
        
        return allocation;
    }

    /**
     * Find hedge opportunities for a position
     */
    findHedgeOpportunities(
        primaryMarket: ParsedWeatherMarket,
        primarySide: 'yes' | 'no',
        primarySize: number,
        allMarkets: ParsedWeatherMarket[]
    ): HedgeOpportunity[] {
        const opportunities: HedgeOpportunity[] = [];
        
        if (!primaryMarket.city) return opportunities;
        
        const primaryCityId = primaryMarket.city.toLowerCase().replace(/\s+/g, '_');
        
        for (const otherMarket of allMarkets) {
            if (otherMarket.market.id === primaryMarket.market.id) continue;
            if (!otherMarket.city) continue;
            
            const otherCityId = otherMarket.city.toLowerCase().replace(/\s+/g, '_');
            
            const correlation = this.getCorrelation(primaryCityId, otherCityId);
            if (!correlation) continue;
            if (correlation.correlationCoefficient < 0.5) continue;  // Need decent correlation for hedge
            
            // Calculate hedge ratio
            // For positive correlation: hedge with opposite position
            // For negative correlation: hedge with same position
            const hedgeRatio = correlation.correlationCoefficient;
            const hedgeSize = primarySize * hedgeRatio;
            
            // Determine hedge side
            const hedgeSide = correlation.correlationCoefficient > 0 
                ? (primarySide === 'yes' ? 'no' : 'yes')  // Opposite for positive correlation
                : primarySide;  // Same for negative correlation
            
            // Calculate residual risk
            const residualRisk = 1 - Math.abs(correlation.correlationCoefficient);
            
            // Estimate expected PnL (simplified)
            const expectedPnL = 0;  // Would need market prices
            
            opportunities.push({
                primaryPosition: {
                    marketId: primaryMarket.market.id,
                    side: primarySide,
                    size: primarySize
                },
                hedgePosition: {
                    marketId: otherMarket.market.id,
                    side: hedgeSide,
                    size: parseFloat(hedgeSize.toFixed(2))
                },
                correlation: correlation.correlationCoefficient,
                hedgeRatio,
                residualRisk,
                expectedPnL
            });
        }
        
        // Sort by lowest residual risk (best hedge)
        opportunities.sort((a, b) => a.residualRisk - b.residualRisk);
        
        return opportunities;
    }

    /**
     * Get all cities correlated with a given city
     */
    getCorrelatedCities(cityId: string, minCorrelation: number = 0.5): Array<{
        cityId: string;
        correlation: number;
        distanceKm: number;
        typicalLagMinutes: number;
    }> {
        const results: Array<{
            cityId: string;
            correlation: number;
            distanceKm: number;
            typicalLagMinutes: number;
        }> = [];
        
        const normalizedCityId = cityId.toLowerCase().replace(/\s+/g, '_');
        
        for (const correlation of this.correlations.values()) {
            if (correlation.cityA === normalizedCityId) {
                if (correlation.correlationCoefficient >= minCorrelation) {
                    results.push({
                        cityId: correlation.cityB,
                        correlation: correlation.correlationCoefficient,
                        distanceKm: correlation.distanceKm,
                        typicalLagMinutes: correlation.typicalLagMinutes
                    });
                }
            } else if (correlation.cityB === normalizedCityId) {
                if (correlation.correlationCoefficient >= minCorrelation) {
                    results.push({
                        cityId: correlation.cityA,
                        correlation: correlation.correlationCoefficient,
                        distanceKm: correlation.distanceKm,
                        typicalLagMinutes: correlation.typicalLagMinutes
                    });
                }
            }
        }
        
        // Sort by correlation strength
        results.sort((a, b) => b.correlation - a.correlation);
        
        return results;
    }

    /**
     * Update correlation data with new observations
     */
    updateCorrelation(
        cityA: string,
        cityB: string,
        observedCorrelation: number,
        sampleSize: number
    ): void {
        const key = this.getCorrelationKey(cityA, cityB);
        const existing = this.correlations.get(key);
        
        if (existing) {
            // Bayesian update of correlation coefficient
            const priorWeight = existing.confidence * 100;  // Convert confidence to sample size
            const totalWeight = priorWeight + sampleSize;
            
            const updatedCorrelation = (
                existing.correlationCoefficient * priorWeight + 
                observedCorrelation * sampleSize
            ) / totalWeight;
            
            existing.correlationCoefficient = updatedCorrelation;
            existing.confidence = Math.min(0.95, existing.confidence + 0.05);
            existing.lastUpdated = new Date();
            
            logger.debug(`[CrossMarketArbitrage] Updated correlation ${cityA}-${cityB}: ${updatedCorrelation.toFixed(3)}`);
        }
    }

    /**
     * Get statistics on correlation database
     */
    getStats(): {
        totalCorrelations: number;
        averageCorrelation: number;
        highCorrelationPairs: number;  // > 0.8
        citiesCovered: number;
    } {
        let totalCorrelation = 0;
        let highCorrelationCount = 0;
        const cities = new Set<string>();
        
        for (const corr of this.correlations.values()) {
            totalCorrelation += corr.correlationCoefficient;
            if (corr.correlationCoefficient > 0.8) {
                highCorrelationCount++;
            }
            cities.add(corr.cityA);
            cities.add(corr.cityB);
        }
        
        return {
            totalCorrelations: this.correlations.size,
            averageCorrelation: this.correlations.size > 0 
                ? totalCorrelation / this.correlations.size 
                : 0,
            highCorrelationPairs: highCorrelationCount,
            citiesCovered: cities.size
        };
    }
}

export default CrossMarketArbitrage;
