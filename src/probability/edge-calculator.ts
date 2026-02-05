/**
 * Edge Calculator
 * Combines Bayesian probability and Market factors to determine true trading edge
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { MarketModel } from './market-model.js';
import { logger } from '../logger.js';

export interface CalculatedEdge {
    marketId: string;
    side: 'yes' | 'no';
    rawEdge: number;      // Prob - Price
    adjustedEdge: number; // After slippage/risk
    confidence: number;   // 0-1
    KellyFraction: number; // Recommended position size %
    reason: string;
    isGuaranteed: boolean; // Whether this is a near-certain outcome
}

export class EdgeCalculator {
    private marketModel: MarketModel;
    private minEdgeThreshold: number;

    constructor(marketModel: MarketModel, minEdgeThreshold: number = 0.10) {
        this.marketModel = marketModel;
        this.minEdgeThreshold = minEdgeThreshold;
    }

    /**
     * Calculate trading edge
     */
    calculateEdge(
        market: ParsedWeatherMarket,
        forecastProbability: number,
        marketPriceYes: number,
        marketPriceNo: number
    ): CalculatedEdge | null {

        // 1. Calculate Raw Edge
        // We can buy YES or NO
        const edgeYes = forecastProbability - marketPriceYes;
        const edgeNo = (1 - forecastProbability) - marketPriceNo;

        let side: 'yes' | 'no';
        let rawEdge: number;
        let price: number;

        if (edgeYes > edgeNo) {
            side = 'yes';
            rawEdge = edgeYes;
            price = marketPriceYes;
        } else {
            side = 'no';
            rawEdge = edgeNo;
            price = marketPriceNo;
        }

        // 2. Adjust for Slippage & Costs
        // For guaranteed outcomes, skip slippage adjustment (we want speed)
        const isGuaranteed = forecastProbability >= 0.99 || forecastProbability <= 0.01;
        let adjustedEdge: number;

        if (isGuaranteed) {
            // For guaranteed outcomes, use raw edge (speed matters more than slippage)
            adjustedEdge = rawEdge;
        } else {
            // Assume standardized $100 entry for estimation
            const estimatedSlippage = this.marketModel.estimateSlippage(market.market.id, 100);
            adjustedEdge = rawEdge - estimatedSlippage;
        }

        // 3. Risk gating
        // For guaranteed outcomes, allow ANY positive edge (0%)
        const effectiveThreshold = isGuaranteed ? 0.00 : this.minEdgeThreshold;
        if (adjustedEdge < effectiveThreshold) {
            return null;
        }

        // 4. Calculate Kelly Criterion
        // f = (bp - q) / b
        // where b = odds - 1 (decimal odds = 1/price)
        // p = probability
        // q = 1-p

        // Simplified: f = edge / (1-p) is not quite right for binary options.
        // For binary options: f = p - (1-p)/b where b = profit/loss ratio
        // If payout is 1.0, cost is C. Win = 1-C, Loss = C. Ratio b = (1-C)/C.
        // Kelly = p/C - q/(1-C) ... wait simplified:
        // Kelly = (p - price) / (1 - price) ??? No. 

        // Correct Kelly for binary options (price P, prob W):
        // f = W/P - (1-W)/(1-P)
        // Actually simpler: f = (Edge) / (Win * Loss) variance?
        // Standard formula: f = p - (1-p) * (loss_amt / win_amt)
        // Loss amt = Price. Win amt = 1 - Price.
        // f = p - (1-p)*(Price / (1-Price))

        const probWin = side === 'yes' ? forecastProbability : (1 - forecastProbability);
        const payoutRatio = (1 - price) / price; // Revenue/Risk

        let kelly = 0;
        if (payoutRatio > 0) {
            kelly = probWin - ((1 - probWin) / payoutRatio);
        }

        // Fractional Kelly for safety (Half-Kelly or Quarter-Kelly)
        const safetyMultiplier = 0.25;
        const finalKelly = Math.max(0, kelly * safetyMultiplier);

        return {
            marketId: market.market.id,
            side,
            rawEdge,
            adjustedEdge,
            // S5: Confidence based on how decisive the forecast is (distance from 50/50)
            // probWin=0.9 → confidence=0.8, probWin=0.6 → confidence=0.2, probWin=0.5 → confidence=0
            confidence: isGuaranteed ? 1.0 : Math.min(1.0, Math.abs(probWin - 0.5) * 2),
            KellyFraction: isGuaranteed ? safetyMultiplier : finalKelly, // Higher Kelly for guaranteed
            reason: `Forecast ${(probWin * 100).toFixed(1)}% vs Price ${(price * 100).toFixed(1)}%${isGuaranteed ? ' (GUARANTEED)' : ''}`,
            isGuaranteed
        };
    }
}
