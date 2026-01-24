/**
 * Speed Arbitrage Strategy
 * Core logic for detecting and acting on opportunities in real-time
 */

import { DataStore } from '../realtime/data-store.js';
import { BayesianModel } from '../probability/bayesian-model.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator, CalculatedEdge } from '../probability/edge-calculator.js';
import { EntryOptimizer, EntrySignal } from './entry-optimizer.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { logger } from '../logger.js';

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
     * Scan all tracked markets for arbitrage opportunities
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const opportunities: EntrySignal[] = [];

        for (const market of markets) {
            const state = this.store.getMarketState(market.market.id);
            if (!state || !state.lastForecast) continue;

            // 1. Get latest prices
            const priceYesPoint = state.priceHistory.yes.history.length > 0 ? state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1] : null;
            const priceNoPoint = state.priceHistory.no.history.length > 0 ? state.priceHistory.no.history[state.priceHistory.no.history.length - 1] : null;

            // If no recent price data (stale > 10 min), skip
            const now = Date.now();
            if (!priceYesPoint || (now - priceYesPoint.timestamp.getTime() > 600000)) continue;

            const priceYes = priceYesPoint.price;
            const priceNo = priceNoPoint ? priceNoPoint.price : (1 - priceYes);

            // 2. Calculate Bayesian Probability
            const forecastProb = this.bayesian.calculateProbability(
                market,
                state.lastForecast.forecastValue,
                state.lastForecast.timestamp
            );

            // 3. Calculate Edge
            const edge = this.edgeCalculator.calculateEdge(
                market,
                forecastProb,
                priceYes,
                priceNo
            );

            if (edge) {
                // 4. Optimize Entry
                const signal = this.entryOptimizer.optimizeEntry(edge);
                opportunities.push(signal);
            }
        }

        return opportunities;
    }
}
