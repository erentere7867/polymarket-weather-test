/**
 * Speed Arbitrage Strategy
 * Core logic for detecting and acting on opportunities in real-time
 */

import { DataStore } from '../realtime/data-store.js';
import { BayesianModel } from '../probability/bayesian-model.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator, CalculatedEdge } from '../probability/edge-calculator.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';
import { logger } from '../logger.js';

export class SpeedArbitrageStrategy {
    private store: DataStore;
    private bayesian: BayesianModel;
    private marketModel: MarketModel;
    private edgeCalculator: EdgeCalculator;

    constructor(store: DataStore) {
        this.store = store;
        this.bayesian = new BayesianModel();
        this.marketModel = new MarketModel(store);
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
    }

    /**
     * Scan all tracked markets for arbitrage opportunities
     */
    detectOpportunities(): CalculatedEdge[] {
        const markets = this.store.getAllMarkets();
        const opportunities: CalculatedEdge[] = [];

        for (const market of markets) {
            const state = this.store.getMarketState(market.market.id);
            if (!state || !state.lastForecast) continue;

            // 1. Get latest prices
            // Use the last known price from history
            const priceYesPoint = state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1];
            const priceNoPoint = state.priceHistory.no.history[state.priceHistory.no.history.length - 1];

            // If no recent price data (stale > 10 min), skip
            const now = Date.now();
            if (!priceYesPoint || (now - priceYesPoint.timestamp.getTime() > 600000)) continue;

            const priceYes = priceYesPoint.price;
            const priceNo = priceNoPoint ? priceNoPoint.price : (1 - priceYes); // Fallback if NO price missing

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
                opportunities.push(edge);

                // Log signal
                /*logger.info(`⚡ SIGNAL: ${edge.side.toUpperCase()} ${market.eventTitle}`, {
                    prob: forecastProb.toFixed(3),
                    price: edge.side === 'yes' ? priceYes.toFixed(3) : priceNo.toFixed(3),
                    edge: edge.adjustedEdge.toFixed(3),
                    kelly: edge.KellyFraction.toFixed(3)
                });*/
            }
        }

        return opportunities;
    }
}
