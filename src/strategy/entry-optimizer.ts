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
        // 1. Determine base size using Kelly Fraction
        // Kelly provides % of bankroll. Here we use it to scale max position.
        // For guaranteed outcomes, use higher position multiplier

        let effectiveMaxPosition = this.maxPositionSize;
        if (edge.isGuaranteed) {
            // Use configurable multiplier for guaranteed outcomes (default 2x)
            effectiveMaxPosition = this.maxPositionSize * config.guaranteedPositionMultiplier;
            logger.info(`🎯 GUARANTEED trade: Using ${config.guaranteedPositionMultiplier}x position size ($${effectiveMaxPosition.toFixed(2)})`);
        }

        let targetSize = effectiveMaxPosition * edge.KellyFraction * edge.confidence;

        // Clamp properties
        targetSize = Math.max(5, targetSize); // Min $5
        targetSize = Math.min(effectiveMaxPosition, targetSize); // Cap at effective max

        // 2. Determine Order Type & Urgency
        // For guaranteed outcomes: ALWAYS HIGH urgency + MARKET order
        // We need to capture the opportunity before market catches up

        let urgency: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
        let orderType: 'MARKET' | 'LIMIT' = 'LIMIT';
        let priceLimit: number | undefined = undefined;

        if (edge.isGuaranteed) {
            // Guaranteed outcomes need maximum speed
            urgency = 'HIGH';
            orderType = 'MARKET';
            logger.info(`🎯 GUARANTEED: Using MARKET order with HIGH urgency for speed arbitrage`);
        } else if (edge.adjustedEdge > 0.15) {
            // Big edge (>15%) - hit it fast
            urgency = 'HIGH';
            orderType = 'MARKET';
        } else {
            // Smaller edges - still use MARKET for speed arbitrage strategy
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
            estimatedEdge: edge.adjustedEdge,
            isGuaranteed: edge.isGuaranteed
        };
    }
}
