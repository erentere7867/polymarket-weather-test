/**
 * Entry Optimizer
 * Determines optimal entry price and timing for trades
 */

import { CalculatedEdge } from '../probability/edge-calculator.js';
import { MarketModel } from '../probability/market-model.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface EntrySignal {
    marketId: string;
    side: 'yes' | 'no';
    size: number;        // Amount in USDC
    priceLimit?: number; // Limit price (optional, if undefined use Market)
    orderType: 'MARKET' | 'LIMIT';
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
    reason: string;
    confidence: number;
    estimatedEdge: number;
    isGuaranteed: boolean; // Whether this is a guaranteed outcome trade
}

export class EntryOptimizer {
    private marketModel: MarketModel;
    private maxPositionSize: number;

    constructor(marketModel: MarketModel, maxPositionSize: number = 50) {
        this.marketModel = marketModel;
        this.maxPositionSize = maxPositionSize;
    }

    /**
     * Optimize entry for a detected edge
     */
    optimizeEntry(edge: CalculatedEdge): EntrySignal {
        // Fast path: For speed arbitrage, use max position size directly
        // Skip complex Kelly calculation for guaranteed outcomes
        let targetSize: number;

        if (edge.isGuaranteed) {
            // Use max position for guaranteed outcomes (fastest path)
            targetSize = this.maxPositionSize * config.guaranteedPositionMultiplier;
        } else {
            // Quick Kelly approximation for non-guaranteed
            targetSize = this.maxPositionSize * edge.KellyFraction * edge.confidence;
        }

        // Clamp to min/max
        targetSize = Math.max(5, Math.min(this.maxPositionSize * config.guaranteedPositionMultiplier, targetSize));

        // Always use MARKET orders for speed arbitrage
        // Skip logging to reduce latency

        return {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(targetSize.toFixed(2)),
            orderType: 'MARKET',
            priceLimit: undefined,
            urgency: edge.isGuaranteed ? 'HIGH' : 'MEDIUM',
            reason: `${edge.reason} | Edge: ${(edge.adjustedEdge * 100).toFixed(1)}%`,
            confidence: edge.confidence,
            estimatedEdge: edge.adjustedEdge,
            isGuaranteed: edge.isGuaranteed
        };
    }
}
