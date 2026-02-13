/**
 * Entry Optimizer - Simplified for Low Latency
 * 
 * Key simplifications:
 * - Fixed position sizes based on sigma confidence bands
 * - No Kelly criterion (removed for speed)
 * - No market impact model (not needed for small positions)
 * - Simplified edge: (probability - price) - 2% for costs
 */

import { CalculatedEdge } from '../probability/edge-calculator.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { OrderBook } from '../polymarket/types.js';

export interface EntrySignal {
    marketId: string;
    side: 'yes' | 'no';
    size: number;            // Amount in USDC
    priceLimit?: number;     // Limit price (optional)
    orderType: 'MARKET' | 'LIMIT';
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
    reason: string;
    confidence: number;
    estimatedEdge: number;
    isGuaranteed: boolean;
    sigma: number;           // Statistical significance
}

// Confidence bands for position sizing
const POSITION_SIZE_BANDS = {
    HIGH: 1.0,      // σ ≥ 2.0: full position
    MEDIUM: 0.75,   // σ ≥ 1.5: 75% of max
    LOW: 0.50,      // σ ≥ 1.0: 50% of max
    SKIP: 0         // σ < 1.0: skip (too uncertain)
};

export class EntryOptimizer {
    private maxPositionSize: number;
    
    constructor(maxPositionSize: number = 50) {
        this.maxPositionSize = maxPositionSize;
    }

    /**
     * Determine position size multiplier based on sigma
     */
    private getPositionSizeMultiplier(sigma: number): number {
        if (sigma >= 2.0) {
            return POSITION_SIZE_BANDS.HIGH;
        } else if (sigma >= 1.5) {
            return POSITION_SIZE_BANDS.MEDIUM;
        } else if (sigma >= 1.0) {
            return POSITION_SIZE_BANDS.LOW;
        } else {
            return POSITION_SIZE_BANDS.SKIP;
        }
    }

    /**
     * Get confidence band label for logging
     */
    private getConfidenceBand(sigma: number): string {
        if (sigma >= 2.0) return 'HIGH (σ≥2.0)';
        if (sigma >= 1.5) return 'MEDIUM (σ≥1.5)';
        if (sigma >= 1.0) return 'LOW (σ≥1.0)';
        return 'SKIP (σ<1.0)';
    }

    /**
     * Analyze basic liquidity (simplified)
     */
    private analyzeLiquidity(orderBook?: OrderBook): { spread: number; bestBid: number; bestAsk: number } {
        if (!orderBook) {
            return { spread: 0.02, bestBid: 0.49, bestAsk: 0.51 };
        }

        const bestBid = orderBook.bids.length > 0 ? parseFloat(orderBook.bids[0].price) : 0;
        const bestAsk = orderBook.asks.length > 0 ? parseFloat(orderBook.asks[0].price) : 1;

        return {
            spread: bestAsk - bestBid,
            bestBid,
            bestAsk
        };
    }

    /**
     * Calculate simplified edge: use rawEdge (already prob - price)
     */
    private calculateSimplifiedEdge(edge: CalculatedEdge): number {
        // rawEdge is already probability - price
        // Use adjustedEdge which includes costs
        return edge.adjustedEdge;
    }

    /**
     * Main entry point - optimized for speed
     */
    optimizeEntry(
        edge: CalculatedEdge,
        orderBook?: OrderBook,
        forecastTimestamp?: Date,
        marketVolume24h?: number,
        sigma?: number
    ): EntrySignal | null {
        const startTime = Date.now();
        
        // Use provided sigma or derive from confidence
        const effectiveSigma = sigma ?? (edge.confidence * 3);
        
        // Skip if sigma too low
        if (effectiveSigma < 1.0) {
            logger.info(`[EntryOptimizer] Skipped: sigma ${effectiveSigma.toFixed(2)} < 1.0 (too uncertain)`);
            return null;
        }

        // Get position size multiplier from sigma
        const sizeMultiplier = this.getPositionSizeMultiplier(effectiveSigma);
        
        // Skip if below threshold
        if (sizeMultiplier === 0) {
            return null;
        }

        // Calculate simplified edge
        const simplifiedEdge = this.calculateSimplifiedEdge(edge);
        
        // Skip if no positive edge after costs
        if (simplifiedEdge <= 0) {
            logger.info(`[EntryOptimizer] Skipped: edge ${(simplifiedEdge * 100).toFixed(2)}% <= 0 after costs`);
            return null;
        }

        // Analyze liquidity
        const liquidity = this.analyzeLiquidity(orderBook);
        
        // Skip if spread too wide (>10%)
        if (liquidity.spread > 0.10) {
            logger.info(`[EntryOptimizer] Skipped: spread ${(liquidity.spread * 100).toFixed(1)}% too wide`);
            return null;
        }

        // Calculate target size
        let targetSize = this.maxPositionSize * sizeMultiplier;
        
        // Reduce for wide spreads
        if (liquidity.spread > 0.05) {
            targetSize *= 0.7;
        }

        // Guaranteed outcomes get boost
        if (edge.isGuaranteed) {
            targetSize = Math.min(targetSize * 1.5, this.maxPositionSize);
        }

        // Determine order type based on urgency
        const urgency = forecastTimestamp 
            ? this.calculateUrgency(forecastTimestamp)
            : 'MEDIUM';

        const orderType = urgency === 'HIGH' ? 'MARKET' : 'LIMIT';
        
        // Calculate limit price
        const priceLimit = orderType === 'LIMIT'
            ? (edge.side === 'yes' ? liquidity.bestAsk : liquidity.bestBid)
            : undefined;

        // Build reason string
        const band = this.getConfidenceBand(effectiveSigma);
        const reason = `${edge.reason} | Edge: ${(simplifiedEdge * 100).toFixed(1)}% | Band: ${band} | Size: $${targetSize.toFixed(2)}`;

        const signal: EntrySignal = {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(targetSize.toFixed(2)),
            orderType,
            priceLimit,
            urgency,
            reason,
            confidence: edge.confidence,
            estimatedEdge: simplifiedEdge,
            isGuaranteed: edge.isGuaranteed,
            sigma: effectiveSigma
        };

        const duration = Date.now() - startTime;
        if (duration > 2) {
            logger.warn(`[EntryOptimizer] Slow optimization: ${duration}ms`);
        }

        return signal;
    }

    /**
     * Calculate urgency based on forecast age
     */
    private calculateUrgency(forecastTimestamp: Date): 'LOW' | 'MEDIUM' | 'HIGH' {
        const ageMs = Date.now() - forecastTimestamp.getTime();
        
        if (ageMs < 60000) return 'HIGH';      // < 1 min
        if (ageMs < 300000) return 'MEDIUM';   // < 5 min
        return 'LOW';
    }

    /**
     * Update max position size
     */
    setMaxPositionSize(size: number): void {
        this.maxPositionSize = size;
        logger.info(`[EntryOptimizer] Max position size updated: $${size}`);
    }
}

export default EntryOptimizer;
