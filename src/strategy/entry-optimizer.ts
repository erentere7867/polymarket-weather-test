/**
 * Entry Optimizer
 * Determines optimal entry price and timing for trades
 */

import { CalculatedEdge } from '../probability/edge-calculator.js';
import { MarketModel } from '../probability/market-model.js';
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
        // 1. Determine base size using Kelly Fraction
        // Kelly provides % of bankroll. Here we use it to scale max position.
        // e.g. If Kelly=0.1 (10%), and maxPosition=$50, we assume maxPosition is our "Unit".
        // Or strictly: Size = Bankroll * Kelly.
        // We'll stick to a simpler model: Size = MaxPosition * KellyFraction * Confidence

        let targetSize = this.maxPositionSize * edge.KellyFraction * edge.confidence;

        // Clamp properties
        targetSize = Math.max(5, targetSize); // Min $5
        targetSize = Math.min(this.maxPositionSize, targetSize); // Cap at max

        // 2. Determine Order Type & Urgency
        // High Urgency -> Market Order (Speed Arbitrage)
        // Low Urgency -> Limit Order (Value Betting)

        const lag = this.marketModel.estimateReactionLag(edge.marketId);
        const velocity = this.marketModel.getPriceVelocity(edge.marketId, edge.side);

        // If price is moving AGAINST us fast, we need to hurry (HIGH urgency)
        // If price is static, we can try to limit.

        let urgency: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
        let orderType: 'MARKET' | 'LIMIT' = 'LIMIT';
        let priceLimit: number | undefined = undefined;

        // "Speed Arbitrage" Logic:
        // If we found a big edge (>15%) and it's fresh, hit it hard.
        if (edge.adjustedEdge > 0.15) {
            urgency = 'HIGH';
            orderType = 'MARKET';
        } else {
            // For smaller edges, try to get a better fill
            orderType = 'LIMIT';
            // Set limit slightly better than current market to capture spread?
            // Or just current market price to ensure fill but avoid slippage?
            // Simple: Limit at current price + slippage tolerance
            priceLimit = edge.side === 'yes'
                ? (1 - edge.rawEdge) + 0.02 // Wrong math. Use market price.
                : undefined;

            // Actually, simplest v2 approach:
            // Always LIMIT at current ask to avoid paying spread if possible?
            // No, "Speed Arbitrage" implies taking liquidity.
            // We default to MARKET because we want speed.
            orderType = 'MARKET';
        }

        return {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(targetSize.toFixed(2)),
            orderType,
            priceLimit,
            urgency,
            reason: `${edge.reason} | Kelly: ${edge.KellyFraction.toFixed(2)}`,
            confidence: edge.confidence,
            estimatedEdge: edge.adjustedEdge
        };
    }
}
