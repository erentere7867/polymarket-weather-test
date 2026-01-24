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

    constructor(store: DataStore) {
        this.store = store;
        this.bayesian = new BayesianModel();
        this.marketModel = new MarketModel(store);
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(this.marketModel);
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
            const forecast = state.lastForecast;

            // Skip if forecast hasn't changed
            if (!forecast.valueChanged) {
                continue;
            }

            // Skip if the change is too old (market has likely caught up)
            const changeAge = now - forecast.changeTimestamp.getTime();
            if (changeAge > MAX_CHANGE_AGE_MS) {
                continue;
            }

            // =====================================================
            // SPEED ARBITRAGE CHECK #2: Is market price stale?
            // =====================================================
            const priceYesPoint = state.priceHistory.yes.history.length > 0
                ? state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1]
                : null;

            if (!priceYesPoint) continue;

            // Check if price was updated AFTER the forecast change
            // If price updated after change, market has already reacted - no edge
            if (priceYesPoint.timestamp.getTime() > forecast.changeTimestamp.getTime()) {
                // Price updated after forecast - check if it moved significantly
                const priceBeforeChange = this.findPriceBeforeChange(state.priceHistory.yes.history, forecast.changeTimestamp);
                const currentPrice = priceYesPoint.price;
                const priceMoved = priceBeforeChange !== null && Math.abs(currentPrice - priceBeforeChange) > 0.05;

                if (priceMoved) {
                    // Market already reacted, skip
                    continue;
                }
            }

            const priceYes = priceYesPoint.price;
            const priceNo = 1 - priceYes;

            // =====================================================
            // SPEED ARBITRAGE CHECK #3: Is this a guaranteed outcome?
            // =====================================================
            // Calculate how far the new forecast is from the threshold
            const threshold = market.threshold;
            if (threshold === undefined) continue;

            let uncertainty: number;
            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_low':
                case 'temperature_threshold':
                    uncertainty = 3; // °F
                    break;
                case 'snowfall':
                    uncertainty = 2; // inches
                    break;
                default:
                    uncertainty = 5;
            }

            const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

            // Only trade if forecast is strongly indicating one direction
            if (sigma < MIN_SIGMA_FOR_ARBITRAGE) {
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

            if (edge && Math.abs(edge.adjustedEdge) >= 0.05) {
                // Log the speed arbitrage opportunity
                logger.info(`🚀 SPEED ARBITRAGE OPPORTUNITY:`, {
                    market: market.market.question.substring(0, 50),
                    forecastChange: `${forecast.previousValue?.toFixed(1)} → ${forecast.forecastValue.toFixed(1)}`,
                    changeAgeSeconds: (changeAge / 1000).toFixed(1),
                    sigma: sigma.toFixed(1),
                    edge: (edge.adjustedEdge * 100).toFixed(1) + '%',
                    side: edge.side,
                    marketPrice: (priceYes * 100).toFixed(1) + '%',
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

