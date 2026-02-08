/**
 * Speed Arbitrage Strategy
 * Fast execution on forecast changes - trades within seconds of new data
 */

import { DataStore } from '../realtime/data-store.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator } from '../probability/edge-calculator.js';
import { EntryOptimizer, EntrySignal } from './entry-optimizer.js';
import { MarketImpactModel } from './market-impact.js';
import { normalCDF } from '../probability/normal-cdf.js';
import { ModelHierarchy } from './model-hierarchy.js';
import { config } from '../config.js';
import { logger, rateLimitedLogger } from '../logger.js';

const MAX_CHANGE_AGE_MS = 120000; // 2 minutes
const MIN_SIGMA_FOR_ARBITRAGE = 0.5;

// Edge decay configuration
const EDGE_DECAY_HALF_LIFE_MS = 60000;  // 1 minute half-life
const EDGE_DECAY_MAX_AGE_MS = 180000;   // 3 minutes max
const URGENCY_SIZE_MULTIPLIER = 1.5;    // Max size boost for fresh signals

export class SpeedArbitrageStrategy {
    private store: DataStore;
    private marketModel: MarketModel;
    private marketImpactModel: MarketImpactModel;
    private edgeCalculator: EdgeCalculator;
    private entryOptimizer: EntryOptimizer;
    private modelHierarchy: ModelHierarchy;

    private capturedOpportunities: Map<string, { forecastValue: number; capturedAt: Date }> = new Map();

    constructor(store: DataStore) {
        this.store = store;
        this.marketModel = new MarketModel(store);
        this.marketImpactModel = new MarketImpactModel();
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(this.marketModel, this.marketImpactModel);
        this.modelHierarchy = new ModelHierarchy();
    }

    /**
     * Mark opportunity as captured
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, { forecastValue, capturedAt: new Date() });
    }

    /**
     * Check if opportunity is already captured
     */
    private isOpportunityCaptured(marketId: string, currentForecastValue: number): boolean {
        const captured = this.capturedOpportunities.get(marketId);
        if (!captured) return false;

        const forecastDiff = Math.abs(currentForecastValue - captured.forecastValue);
        if (forecastDiff >= 1.0) {
            this.capturedOpportunities.delete(marketId);
            return false;
        }

        return true;
    }

    /**
     * Detect opportunity for a specific market
     */
    detectOpportunity(marketId: string): EntrySignal | null {
        const state = this.store.getMarketState(marketId);
        if (!state?.lastForecast) return null;

        const market = state.market;
        const now = Date.now();
        const forecast = state.lastForecast;

        // Must be a recent change (not first data)
        if (forecast.previousValue === undefined) return null;

        const changeAge = now - forecast.changeTimestamp.getTime();
        if (!forecast.valueChanged || changeAge > MAX_CHANGE_AGE_MS) {
            return null;
        }

        // Check if already captured
        if (this.isOpportunityCaptured(market.market.id, forecast.forecastValue)) {
            return null;
        }

        // Get current price
        const priceHistory = state.priceHistory.yes.history;
        if (priceHistory.length === 0) return null;
        
        const priceYes = priceHistory[priceHistory.length - 1].price;
        const priceNo = 1 - priceYes;

        // Calculate threshold
        let threshold = market.threshold;
        if (threshold === undefined) return null;
        if (market.thresholdUnit === 'C') {
            threshold = (threshold * 9 / 5) + 32;
        }

        // Calculate sigma
        const daysToEvent = market.targetDate
            ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
            : 3;
        
        const uncertainty = 1.5 + 0.8 * daysToEvent;
        const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

        if (sigma < MIN_SIGMA_FOR_ARBITRAGE) return null;

        // Calculate probability
        let forecastProb: number;
        if (market.comparisonType === 'above') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'above');
        } else if (market.comparisonType === 'below') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'below');
        } else {
            return null;
        }

        // Calculate edge
        const edge = this.edgeCalculator.calculateEdge(market, forecastProb, priceYes, priceNo);
        if (!edge || Math.abs(edge.adjustedEdge) < 0.02) return null;

        // Calculate edge decay based on signal age
        const decayFactor = this.calculateEdgeDecayFactor(changeAge);
        const decayedEdge = edge.adjustedEdge * decayFactor;
        
        // Skip if decayed edge is too small
        if (Math.abs(decayedEdge) < 0.02) {
            logger.debug(`Speed arb: Edge decayed too much (${(decayedEdge * 100).toFixed(1)}%), skipping`);
            return null;
        }

        // Calculate urgency-based size multiplier
        const urgencyMultiplier = this.calculateUrgencySizeMultiplier(changeAge);
        
        // Calculate final position size with decay and urgency
        let positionSize = config.maxPositionSize * decayFactor * urgencyMultiplier;
        
        // Boost size for high-sigma opportunities
        if (sigma >= 2.0) {
            positionSize *= 1.3;  // 30% boost for high confidence
        } else if (sigma >= 1.5) {
            positionSize *= 1.15;  // 15% boost for medium-high confidence
        }
        
        // Cap at maximum
        positionSize = Math.min(positionSize, config.maxPositionSize * config.guaranteedPositionMultiplier * 1.5);

        logger.info(`Speed arb: ${market.market.question.substring(0, 50)} | edge=${(edge.adjustedEdge * 100).toFixed(1)}% | decayed=${(decayedEdge * 100).toFixed(1)}% | σ=${sigma.toFixed(1)} | size=$${positionSize.toFixed(2)}`);

        return {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(positionSize.toFixed(2)),
            orderType: 'MARKET',
            urgency: 'HIGH',
            estimatedEdge: decayedEdge,
            confidence: edge.confidence * decayFactor,
            reason: `Speed: ${sigma.toFixed(1)}σ, edge ${(edge.adjustedEdge * 100).toFixed(1)}% (decayed: ${(decayedEdge * 100).toFixed(1)}%)`,
            isGuaranteed: edge.isGuaranteed,
            sigma: sigma,
            decayFactor: parseFloat(decayFactor.toFixed(3))
        };
    }

    /**
     * Calculate edge decay factor based on signal age
     * Uses exponential decay with configurable half-life
     */
    private calculateEdgeDecayFactor(ageMs: number): number {
        if (ageMs > EDGE_DECAY_MAX_AGE_MS) {
            return 0.1;  // Minimum 10% after max age
        }
        
        // Exponential decay: factor = 0.5^(age/half_life)
        const decayFactor = Math.exp(-ageMs / EDGE_DECAY_HALF_LIFE_MS * Math.LN2);
        
        // Ensure minimum factor of 0.3
        return Math.max(0.3, decayFactor);
    }

    /**
     * Calculate urgency-based size multiplier
     * Higher multiplier for fresh signals to capture maximum alpha
     */
    private calculateUrgencySizeMultiplier(ageMs: number): number {
        if (ageMs < 5000) {
            // First 5 seconds: Maximum urgency
            return URGENCY_SIZE_MULTIPLIER;
        } else if (ageMs < 15000) {
            // 5-15 seconds: High urgency
            return 1.3;
        } else if (ageMs < 30000) {
            // 15-30 seconds: Medium urgency
            return 1.1;
        } else if (ageMs < 60000) {
            // 30-60 seconds: Low urgency
            return 1.0;
        } else {
            // After 1 minute: Normal sizing
            return 0.9;
        }
    }

    /**
     * Scan all markets for opportunities
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const opportunities: EntrySignal[] = [];

        for (const market of markets) {
            const signal = this.detectOpportunity(market.market.id);
            if (signal) opportunities.push(signal);
        }

        return opportunities;
    }

    /**
     * Calculate probability using normal CDF
     */
    private calculateProbability(forecastValue: number, threshold: number, comparisonType: 'above' | 'below'): number {
        const UNCERTAINTY = 3;
        const z = (forecastValue - threshold) / UNCERTAINTY;
        
        if (comparisonType === 'above') {
            return normalCDF(z);
        } else {
            return 1 - normalCDF(z);
        }
    }
}

export default SpeedArbitrageStrategy;
