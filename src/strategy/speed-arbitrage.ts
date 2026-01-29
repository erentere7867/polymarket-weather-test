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
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Maximum age of a forecast change before it's considered "stale" (market has caught up)
// AGGRESSIVE: 15 seconds - act fast before market reacts
const MAX_CHANGE_AGE_MS = 15000;

// Minimum change threshold to trigger detection
// AGGRESSIVE: 1.5 sigma = more opportunities, slightly lower confidence
const MIN_SIGMA_FOR_ARBITRAGE = 1.5;

export class SpeedArbitrageStrategy {
    private store: DataStore;
    private bayesian: BayesianModel;
    private marketModel: MarketModel;
    private edgeCalculator: EdgeCalculator;
    private entryOptimizer: EntryOptimizer;

    // Track opportunities we've already captured - prevents re-buying at higher prices
    // Key: marketId, Value: { forecastValue we traded on, when we captured it }
    private capturedOpportunities: Map<string, { forecastValue: number; capturedAt: Date }> = new Map();

    constructor(store: DataStore) {
        this.store = store;
        this.bayesian = new BayesianModel();
        this.marketModel = new MarketModel(store);
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(this.marketModel);
    }

    /**
     * Mark an opportunity as captured - prevents re-entry until NEW forecast change
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, {
            forecastValue,
            capturedAt: new Date()
        });
        logger.info(`📌 Marked opportunity captured: ${marketId} at forecast ${forecastValue.toFixed(1)}`);
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
            logger.info(`🔄 New forecast for ${marketId}: ${captured.forecastValue.toFixed(1)} → ${currentForecastValue.toFixed(1)}, allowing re-entry`);
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

        for (const market of markets) {
            const state = this.store.getMarketState(market.market.id);
            if (!state || !state.lastForecast) continue;

            // =====================================================
            // SPEED ARBITRAGE CHECK #1: Did forecast change recently?
            // =====================================================
            // =====================================================
            // STRATEGY BRANCHING: Speed vs Value
            // =====================================================
            const forecast = state.lastForecast;
            const changeAge = now - forecast.changeTimestamp.getTime();
            const isSpeedArb = forecast.valueChanged && (changeAge <= MAX_CHANGE_AGE_MS);

            // =====================================================
            // CHECK #1: Have we already captured this opportunity?
            // =====================================================
            if (this.isOpportunityCaptured(market.market.id, forecast.forecastValue)) {
                // If it's a speed arb (fresh change), maybe we want to double down? 
                // For now, safety first: strictly respect capture flag.
                // logger.debug(`⏭️ Skipping already captured: ${market.market.question.substring(0, 40)}...`);
                continue;
            }

            // =====================================================
            // CHECK #2: Market Reaction (Speed Arb only)
            // =====================================================
            const priceYesPoint = state.priceHistory.yes.history.length > 0
                ? state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1]
                : null;

            if (!priceYesPoint) continue;

            const priceYes = priceYesPoint.price;
            const priceNo = 1 - priceYes;

            if (isSpeedArb) {
                // For speed arb, ensure market hasn't already reacted to THIS change
                if (priceYesPoint.timestamp.getTime() > forecast.changeTimestamp.getTime()) {
                    const priceBeforeChange = this.findPriceBeforeChange(state.priceHistory.yes.history, forecast.changeTimestamp);
                    
                    if (priceBeforeChange !== null) {
                        const diff = forecast.forecastValue - (market.threshold || 0);
                        const expectedProb = market.comparisonType === 'above' ? (diff > 0 ? 1 : 0) : (diff < 0 ? 1 : 0);
                        const priceMovedTowards = (expectedProb > 0.5 && priceYes > priceBeforeChange) ||
                                                (expectedProb < 0.5 && priceYes < priceBeforeChange);
                        
                        if (priceMovedTowards && Math.abs(priceYes - priceBeforeChange) > 0.05) {
                            continue; // Market beat us
                        }
                    }
                }
            }

            // =====================================================
            // CHECK #3: Certainty Threshold (Dynamic Sigma)
            // =====================================================
            let threshold = market.threshold;
            if (threshold === undefined) continue;

            // Normalize threshold to F if needed
            if (market.thresholdUnit === 'C') {
                threshold = (threshold * 9 / 5) + 32;
            }

            let uncertainty: number;
            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_low':
                case 'temperature_threshold':
                    uncertainty = 3; 
                    break;
                default:
                    uncertainty = 5;
            }

            const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

            // DYNAMIC THRESHOLD:
            // Speed Arb (Fresh News): Accept 1.5 sigma (aggressive)
            // Value Arb (Stale News): Require 2.5 sigma (conservative, deep value)
            const requiredSigma = isSpeedArb ? MIN_SIGMA_FOR_ARBITRAGE : 2.5;

            if (sigma < requiredSigma) {
                continue;
            }

            // Determine guaranteed probability
            const diff = forecast.forecastValue - threshold;
            let guaranteedProb: number;

            if (market.comparisonType === 'above') {
                guaranteedProb = diff > 0 ? 1.0 : 0.0;
            } else if (market.comparisonType === 'below') {
                guaranteedProb = diff < 0 ? 1.0 : 0.0;
            } else {
                continue;
            }

            // Calculate edge
            const edge = this.edgeCalculator.calculateEdge(
                market,
                guaranteedProb,
                priceYes,
                priceNo
            );

            // Require slightly higher edge for stale data to cover spread/risk
            const minEdge = isSpeedArb ? 0.05 : 0.10;

            if (edge && Math.abs(edge.adjustedEdge) >= minEdge) {
                // Log the opportunity
                logger.info(isSpeedArb ? `🚀 SPEED ARB OPPORTUNITY:` : `💎 VALUE ARB OPPORTUNITY:`, {
                    market: market.market.question.substring(0, 50),
                    forecast: `${forecast.forecastValue.toFixed(1)} (Threshold: ${threshold})`,
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

