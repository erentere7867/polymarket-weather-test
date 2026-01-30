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

        // For speed arb, ensure market hasn't already reacted to THIS change
        if (priceYesPoint.timestamp.getTime() > forecast.changeTimestamp.getTime()) {
            const priceBeforeChange = this.findPriceBeforeChange(state.priceHistory.yes.history, forecast.changeTimestamp);
            
            if (priceBeforeChange !== null) {
                const diff = forecast.forecastValue - (market.threshold || 0);
                const expectedProb = market.comparisonType === 'above' ? (diff > 0 ? 1 : 0) : (diff < 0 ? 1 : 0);
                const priceMovedTowards = (expectedProb > 0.5 && priceYes > priceBeforeChange) ||
                                        (expectedProb < 0.5 && priceYes < priceBeforeChange);
                
                if (priceMovedTowards && Math.abs(priceYes - priceBeforeChange) > 0.05) {
                    return null; // Market beat us
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

        // DYNAMIC THRESHOLD: Speed Arb (Fresh News) -> Accept 1.5 sigma
        if (sigma < MIN_SIGMA_FOR_ARBITRAGE) {
            return null;
        }

        // Determine guaranteed probability
        const diff = forecast.forecastValue - threshold;
        let guaranteedProb: number;

        if (market.comparisonType === 'above') {
            guaranteedProb = diff > 0 ? 1.0 : 0.0;
        } else if (market.comparisonType === 'below') {
            guaranteedProb = diff < 0 ? 1.0 : 0.0;
        } else {
            return null;
        }

        // Calculate edge
        const edge = this.edgeCalculator.calculateEdge(
            market,
            guaranteedProb,
            priceYes,
            priceNo
        );

        // Require slightly higher edge for stale data to cover spread/risk
        const minEdge = 0.05; // 5% edge for speed arb

        if (edge && Math.abs(edge.adjustedEdge) >= minEdge) {
            logger.info(`🚀 SPEED ARB OPPORTUNITY DETECTED:`, {
                market: market.market.question.substring(0, 50),
                forecast: `${forecast.forecastValue.toFixed(1)} (Threshold: ${threshold})`,
                sigma: sigma.toFixed(1),
                edge: (edge.adjustedEdge * 100).toFixed(1) + '%',
                price: (priceYes * 100).toFixed(1) + '%',
            });

            return this.entryOptimizer.optimizeEntry(edge);
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


