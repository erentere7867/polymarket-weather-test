/**
 * Speed Arbitrage Strategy
 * Core logic for detecting and acting on opportunities in real-time
 * 
 * KEY PRINCIPLE: Only trade when we have FRESHER information than the market.
 * NOT just any price discrepancy - only TIMING edges.
 */

import { DataStore } from '../realtime/data-store.js';
import { BayesianModel } from '../probability/bayesian-model.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator, CalculatedEdge } from '../probability/edge-calculator.js';
import { EntryOptimizer, EntrySignal } from './entry-optimizer.js';
import { MarketImpactModel } from './market-impact.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { normalCDF } from '../probability/normal-cdf.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Maximum age of a forecast change before it's considered "stale" (market has caught up)
// RELAXED: 120 seconds - markets take time to react to forecast changes
const MAX_CHANGE_AGE_MS = 120000;

// Minimum change threshold to trigger detection
// S9: Require at least 0.5 sigma to avoid trading on noise
const MIN_SIGMA_FOR_ARBITRAGE = 0.5;

export class SpeedArbitrageStrategy {
    private store: DataStore;
    private bayesian: BayesianModel;
    private marketModel: MarketModel;
    private marketImpactModel: MarketImpactModel;
    private edgeCalculator: EdgeCalculator;
    private entryOptimizer: EntryOptimizer;

    // Track opportunities we've already captured - prevents re-buying at higher prices
    // Key: marketId, Value: { forecastValue we traded on, when we captured it }
    private capturedOpportunities: Map<string, { forecastValue: number; capturedAt: Date }> = new Map();

    // Track forecasts we've already analyzed (traded OR skipped) to prevent loop spam
    private processedForecasts: Map<string, number> = new Map();

    // Skip market price reaction check - trade immediately on forecast changes
    private skipPriceCheck: boolean = false;

    constructor(store: DataStore) {
        this.store = store;
        this.bayesian = new BayesianModel();
        this.marketModel = new MarketModel(store);
        this.marketImpactModel = new MarketImpactModel();
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(this.marketModel, this.marketImpactModel);
    }

    /**
     * Set whether to skip market price reaction check
     */
    setSkipPriceCheck(skip: boolean): void {
        this.skipPriceCheck = skip;
    }

    /**
     * Get current skipPriceCheck setting
     */
    getSkipPriceCheck(): boolean {
        return this.skipPriceCheck;
    }

    /**
     * Mark an opportunity as captured - prevents re-entry until NEW forecast change
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, {
            forecastValue,
            capturedAt: new Date()
        });
        // Forecast values disabled per user request
        logger.info(`📌 Marked opportunity captured: ${marketId}`);
    }

    /**
     * Check if we've already captured this opportunity
     */
    private isOpportunityCaptured(marketId: string, currentForecastValue: number): boolean {
        const captured = this.capturedOpportunities.get(marketId);
        if (!captured) return false;

        // Allow re-entry only if forecast value changed significantly (new opportunity)
        const forecastDiff = Math.abs(currentForecastValue - captured.forecastValue);
        const significantChange = forecastDiff >= 1.0; // 1 degree or 1 inch = new opportunity

        if (significantChange) {
            // New forecast value! Clear the captured flag
            this.capturedOpportunities.delete(marketId);
            // Forecast values disabled per user request
            logger.info(`🔄 New forecast for ${marketId}: allowing re-entry`);
            return false;
        }

        return true; // Still captured, block re-entry
    }

    /**
     * Check a specific market for speed arbitrage opportunity
     * Optimized for single-market "Interrupt" checks
     */
    detectOpportunity(marketId: string): EntrySignal | null {
        const state = this.store.getMarketState(marketId);
        if (!state || !state.lastForecast) return null;

        const market = state.market;
        const now = Date.now();
        const forecast = state.lastForecast;

        // =====================================================
        // SPEED ARBITRAGE CHECK #1: Did forecast change recently?
        // =====================================================
        const changeAge = now - forecast.changeTimestamp.getTime();
        const isSpeedArb = forecast.valueChanged && (changeAge <= MAX_CHANGE_AGE_MS);

        if (!isSpeedArb) {
            // In strict speed mode, we only care about fresh changes
            return null;
        }

        // =====================================================
        // CHECK #1: Have we already captured this opportunity?
        // =====================================================
        if (this.isOpportunityCaptured(market.market.id, forecast.forecastValue)) {
            return null;
        }

        // =====================================================
        // CHECK #2: Market Reaction (Speed Arb only)
        // =====================================================
        const priceYesPoint = state.priceHistory.yes.history.length > 0
            ? state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1]
            : null;

        if (!priceYesPoint) return null;

        const priceYes = priceYesPoint.price;
        const priceNo = 1 - priceYes;

        // For speed arb, only block if market moved >80% toward fair value (price almost fully caught up)
        if (priceYesPoint.timestamp.getTime() > forecast.changeTimestamp.getTime()) {
            const priceBeforeChange = this.findPriceBeforeChange(state.priceHistory.yes.history, forecast.changeTimestamp);
            
            if (priceBeforeChange !== null) {
                const diff = forecast.forecastValue - (market.threshold || 0);
                const expectedProb = market.comparisonType === 'above' ? (diff > 0 ? 1 : 0) : (diff < 0 ? 1 : 0);
                const priceMovedTowards = (expectedProb > 0.5 && priceYes > priceBeforeChange) ||
                                        (expectedProb < 0.5 && priceYes < priceBeforeChange);
                const priceMovement = Math.abs(priceYes - priceBeforeChange);
                
                // Only block if market moved >15¢ toward expected — that means most of the edge is gone
                if (priceMovedTowards && priceMovement > 0.15) {
                    return null; // Market already caught up
                }
            }
        }

        // =====================================================
        // CHECK #3: Certainty Threshold (Dynamic Sigma)
        // =====================================================
        let threshold = market.threshold;
        if (threshold === undefined) return null;

        // Normalize threshold to F if needed
        if (market.thresholdUnit === 'C') {
            threshold = (threshold * 9 / 5) + 32;
        }

        // Dynamic uncertainty based on days to event
        const daysToEvent = market.targetDate
            ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
            : 3;
        let uncertainty: number;
        switch (market.metricType) {
            case 'temperature_high':
            case 'temperature_low':
            case 'temperature_threshold':
                uncertainty = 1.5 + 0.8 * daysToEvent;
                break;
            default:
                uncertainty = 3 + 1.0 * daysToEvent;
        }

        const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

        // DYNAMIC THRESHOLD: Speed Arb (Fresh News) -> Accept 1.5 sigma
        if (sigma < MIN_SIGMA_FOR_ARBITRAGE) {
            return null;
        }

        // C3: Use proper CDF probability instead of binary 0/1
        let forecastProb: number;

        if (market.comparisonType === 'above') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'above');
        } else if (market.comparisonType === 'below') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'below');
        } else {
            return null;
        }

        // Calculate edge
        const edge = this.edgeCalculator.calculateEdge(
            market,
            forecastProb,
            priceYes,
            priceNo
        );

        // Speed arb: lower edge threshold (2%) — stale price IS the edge
        const minEdge = 0.02;

        if (edge && Math.abs(edge.adjustedEdge) >= minEdge) {
            logger.info(`🚀 SPEED ARB OPPORTUNITY DETECTED:`, {
                market: market.market.question.substring(0, 50),
                forecast: `${forecast.forecastValue.toFixed(1)} (Threshold: ${threshold})`,
                sigma: sigma.toFixed(1),
                edge: (edge.adjustedEdge * 100).toFixed(1) + '%',
                price: (priceYes * 100).toFixed(1) + '%',
                daysToEvent: daysToEvent.toFixed(1),
                uncertainty: uncertainty.toFixed(1),
            });

            // Build minimal EntrySignal directly — skip EntryOptimizer for speed
            return {
                marketId: edge.marketId,
                side: edge.side,
                size: config.maxPositionSize,
                orderType: 'MARKET' as const,
                urgency: 'HIGH' as const,
                estimatedEdge: edge.adjustedEdge,
                confidence: edge.confidence,
                reason: `SPEED ARB: ${sigma.toFixed(1)}σ, edge ${(edge.adjustedEdge * 100).toFixed(1)}%`,
                isGuaranteed: edge.isGuaranteed,
            };
        }

        return null;
    }

    /**
     * Scan all tracked markets for SPEED ARBITRAGE opportunities
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const opportunities: EntrySignal[] = [];

        for (const market of markets) {
            const signal = this.detectOpportunity(market.market.id);
            if (signal) {
                opportunities.push(signal);
            }
        }

        return opportunities;
    }

    /**
     * Calculate probability using normal CDF approximation
     * Instead of binary 0%/100%, uses nuanced probability based on distance from threshold
     *
     * @param forecastValue - The forecasted value (e.g., temperature)
     * @param threshold - The market threshold
     * @param comparisonType - 'above' or 'below'
     * @returns Probability between 0 and 1
     */
    private calculateProbability(
        forecastValue: number,
        threshold: number,
        comparisonType: 'above' | 'below'
    ): number {
        const UNCERTAINTY = 3; // Fixed uncertainty of 3°F
        const z = (forecastValue - threshold) / UNCERTAINTY;
        
        if (comparisonType === 'above') {
            // P(actual >= threshold) = CDF(z)
            return normalCDF(z);
        } else {
            // P(actual < threshold) = 1 - CDF(z)
            return 1 - normalCDF(z);
        }
    }

    /**
     * Find the price that was active before a forecast change occurred
     */
    private findPriceBeforeChange(history: { price: number; timestamp: Date }[], changeTime: Date): number | null {
        // Look for the last price BEFORE the change timestamp
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].timestamp.getTime() < changeTime.getTime()) {
                return history[i].price;
            }
        }
        return null;
    }
}


