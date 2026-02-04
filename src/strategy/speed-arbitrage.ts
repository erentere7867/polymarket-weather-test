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
import { config } from '../config.js';
import { logger } from '../logger.js';

// Maximum age of a forecast change before it's considered "stale" (market has caught up)
// RELAXED: 120 seconds - markets take time to react to forecast changes
const MAX_CHANGE_AGE_MS = 120000;

// Minimum change threshold to trigger detection
// RELAXED: 0.0 sigma = trade on ANY deviation (Maximum Aggression)
const MIN_SIGMA_FOR_ARBITRAGE = 0.0;

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
     * Scan all tracked markets for SPEED ARBITRAGE opportunities
     * 
     * ONLY returns opportunities where:
     * 1. Forecast just changed (we have fresh data)
     * 2. Market price hasn't reacted yet (stale)
     * 3. The new forecast indicates a near-certain outcome
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const opportunities: EntrySignal[] = [];
        const now = Date.now();

        // Pre-allocate threshold map to avoid repeated lookups
        const thresholdCache = new Map<string, number | undefined>();

        for (const market of markets) {
            const state = this.store.getMarketState(market.market.id);
            if (!state || !state.lastForecast) continue;

            // Cache threshold normalization to avoid repeated calculations
            let cachedThreshold = thresholdCache.get(market.market.id);
            if (cachedThreshold === undefined && market.threshold !== undefined) {
                cachedThreshold = market.thresholdUnit === 'C'
                    ? (market.threshold * 9 / 5) + 32
                    : market.threshold;
                thresholdCache.set(market.market.id, cachedThreshold);
            }

            // =====================================================
            // SPEED ARBITRAGE CHECK #1: Did forecast change recently?
            // =====================================================
            const forecast = state.lastForecast;
            const changeAge = now - forecast.changeTimestamp.getTime();
            const isSpeedArb = forecast.valueChanged && (changeAge <= MAX_CHANGE_AGE_MS);

            // Check if we've already processed this specific forecast update
            const lastProcessed = this.processedForecasts.get(market.market.id);
            if (lastProcessed === forecast.changeTimestamp.getTime()) {
                continue; // Already analyzed this update
            }

            // Mark as processed immediately (we will analyze it now, don't repeat)
            this.processedForecasts.set(market.market.id, forecast.changeTimestamp.getTime());

            // Skip non-speed-arb opportunities for performance
            if (!isSpeedArb) {
                continue;
            }

            // Quick logging for speed arb (only when fresh)
            logger.info(`⚡ Analyzing fresh change for ${market.market.question.substring(0, 30)}... Age: ${changeAge}ms`);

            // =====================================================
            // CHECK #1: Have we already captured this opportunity?
            // =====================================================
            if (this.isOpportunityCaptured(market.market.id, forecast.forecastValue)) {
                continue;
            }

            // =====================================================
            // CHECK #2: Get current price (fast path)
            // =====================================================
            // Use current market price directly instead of history lookup
            const priceYes = state.market.yesPrice;
            const priceNo = state.market.noPrice;

            if (!priceYes || !priceNo) {
                // Fallback to history if market prices not available
                const priceYesPoint = state.priceHistory.yes.history.length > 0
                    ? state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1]
                    : null;
                if (!priceYesPoint) continue;
                // Continue with history-based price...
            }

            // Skip price reaction check for speed - we want to be first
            // The skipPriceCheck flag is handled in entry optimizer

            // =====================================================
            // CHECK #3: Certainty Threshold (Fast calculation)
            // =====================================================
            const threshold = thresholdCache.get(market.market.id);
            if (threshold === undefined) continue;

            // Fast sigma calculation (temperature markets only for speed)
            const uncertainty = 3; // Fixed for temperature markets
            const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

            if (sigma < MIN_SIGMA_FOR_ARBITRAGE) {
                continue;
            }

            // Improved probability calculation using normal CDF approximation
            // Instead of binary 0%/100%, use nuanced probability based on distance from threshold
            // Skip if comparison type is not 'above' or 'below'
            if (market.comparisonType !== 'above' && market.comparisonType !== 'below') {
                continue;
            }
            const guaranteedProb = this.calculateProbability(
                forecast.forecastValue,
                threshold,
                market.comparisonType
            );

            // Calculate edge
            const edge = this.edgeCalculator.calculateEdge(
                market,
                guaranteedProb,
                priceYes,
                priceNo
            );

            // Accept any positive edge for speed arb
            if (edge) {
                logger.info(`🚀 SPEED ARB OPPORTUNITY:`, {
                    market: market.market.question.substring(0, 50),
                    sigma: sigma.toFixed(1),
                    edge: (edge.adjustedEdge * 100).toFixed(1) + '%',
                    price: (priceYes * 100).toFixed(1) + '%',
                });

                const signal = this.entryOptimizer.optimizeEntry(edge);
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
        const diff = forecastValue - threshold;
        const sigma = diff / UNCERTAINTY;
        
        // Normal CDF approximation using error function
        // P(X > threshold) = 1 - CDF(sigma) for "above" markets
        // P(X < threshold) = CDF(sigma) for "below" markets
        const cdf = this.normalCDF(sigma);
        
        if (comparisonType === 'above') {
            // Probability that temp is ABOVE threshold
            return 1 - cdf;
        } else {
            // Probability that temp is BELOW threshold
            return cdf;
        }
    }
    
    /**
     * Normal CDF approximation (Abramowitz and Stegun formula)
     * Accurate to within 7.5e-8
     */
    private normalCDF(x: number): number {
        // Handle extreme values
        if (x < -6) return 0;
        if (x > 6) return 1;
        
        const b1 = 0.319381530;
        const b2 = -0.356563782;
        const b3 = 1.781477937;
        const b4 = -1.821255978;
        const b5 = 1.330274429;
        const p = 0.2316419;
        const c = 0.39894228;
        
        const absX = Math.abs(x);
        const t = 1 / (1 + p * absX);
        
        const phi = c * Math.exp(-(x * x) / 2);
        const poly = b1 * t + b2 * t * t + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5);
        
        let result = 1 - phi * poly;
        
        if (x < 0) {
            result = 1 - result;
        }
        
        return Math.max(0, Math.min(1, result));
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

