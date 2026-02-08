/**
 * Entry Optimizer - Advanced Position Sizing and Entry Optimization
 * 
 * Features:
 * - Market liquidity awareness (order book depth analysis)
 * - Volatility-adjusted position sizing
 * - Full Kelly Criterion calculation with win/loss ratio
 * - Position scaling (gradual entry)
 * - Urgency factor based on forecast freshness
 * - Integration with Market Impact Model
 */

import { CalculatedEdge } from '../probability/edge-calculator.js';
import { MarketModel } from '../probability/market-model.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { MarketImpactModel } from './market-impact.js';
import { OrderBook } from '../polymarket/types.js';

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
    
    // Advanced fields
    scaleInOrders?: ScaleInOrder[];  // For position scaling
    urgencyFactor?: number;           // 0-1 urgency multiplier
    expectedSlippage?: number;        // Estimated slippage
    marketImpact?: number;            // Estimated market impact
    
    // New: Dynamic Kelly and partial exit fields
    kellyFraction?: number;           // Applied Kelly fraction for this trade
    sigma?: number;                   // Statistical significance (sigma)
    decayFactor?: number;             // Edge decay factor
    partialExitTriggers?: PartialExitTrigger[]; // Partial exit levels
}

export interface PartialExitTrigger {
    percentOfPosition: number;        // e.g., 0.5 for 50%
    profitThreshold: number;          // e.g., 0.05 for 5% profit
    orderType: 'MARKET' | 'LIMIT';
}

export interface ScaleInOrder {
    size: number;
    price: number;
    delayMs: number;  // Delay before this tranche
    orderType: 'MARKET' | 'LIMIT';
}

export interface OrderBookDepth {
    totalBidDepth: number;    // Total USDC on bid side
    totalAskDepth: number;    // Total USDC on ask side
    spread: number;           // Current spread
    bestBid: number;
    bestAsk: number;
    depthScore: number;       // 0-1 liquidity score
}

export interface VolatilityMetrics {
    priceVolatility: number;  // Standard deviation of price changes
    volumeVolatility: number; // Volume variance
    recentVolatility: number; // Recent price movement speed
    volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
}

export interface KellyInputs {
    winProbability: number;
    lossProbability: number;
    avgWin: number;           // Average win amount (as multiple of stake)
    avgLoss: number;          // Average loss amount (as multiple of stake)
    winLossRatio: number;     // avgWin / avgLoss
}

export class EntryOptimizer {
    private marketModel: MarketModel;
    private marketImpactModel: MarketImpactModel;
    private maxPositionSize: number;
    
    // Configuration - Dynamic Kelly based on sigma/confidence
    private readonly KELLY_FRACTION_HIGH_CONFIDENCE = 0.50;  // Half-Kelly for sigma > 2.0
    private readonly KELLY_FRACTION_MEDIUM_CONFIDENCE = 0.25; // Quarter-Kelly for 0.5 < sigma < 2.0
    private readonly KELLY_FRACTION_LOW_CONFIDENCE = 0.125;  // 1/8-Kelly for low confidence
    private readonly KELLY_FRACTION_GUARANTEED = 0.75;       // 3/4-Kelly for guaranteed outcomes
    
    private readonly VOLATILITY_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
    private readonly URGENCY_DECAY_MS = 30 * 1000;  // 30 seconds for urgency decay
    private readonly SCALE_IN_THRESHOLD = 100;  // Scale in for positions > $100
    private readonly MAX_SCALE_IN_TRANCHES = 3;
    
    // Volatility thresholds
    private readonly VOLATILITY_LOW = 0.01;      // 1% price movement
    private readonly VOLATILITY_HIGH = 0.05;     // 5% price movement
    private readonly VOLATILITY_EXTREME = 0.10;  // 10% price movement
    
    // Edge decay configuration
    private readonly EDGE_DECAY_HALF_LIFE_MS = 60000;  // 1 minute half-life
    private readonly MAX_EDGE_AGE_MS = 120000;  // 2 minutes max

    constructor(
        marketModel: MarketModel, 
        marketImpactModel: MarketImpactModel,
        maxPositionSize: number = 50
    ) {
        this.marketModel = marketModel;
        this.marketImpactModel = marketImpactModel;
        this.maxPositionSize = maxPositionSize;
    }

    /**
     * Get dynamic Kelly fraction based on sigma and confidence
     */
    private getDynamicKellyFraction(sigma: number, isGuaranteed: boolean): number {
        if (isGuaranteed) {
            return this.KELLY_FRACTION_GUARANTEED;
        }
        
        if (sigma >= 2.0) {
            // High confidence: Half-Kelly
            return this.KELLY_FRACTION_HIGH_CONFIDENCE;
        } else if (sigma >= 1.0) {
            // Medium confidence: Quarter-Kelly
            return this.KELLY_FRACTION_MEDIUM_CONFIDENCE;
        } else if (sigma >= 0.5) {
            // Low confidence: 1/8-Kelly
            return this.KELLY_FRACTION_LOW_CONFIDENCE;
        } else {
            // Very low confidence: Don't trade or minimal sizing
            return 0.05;  // 1/20-Kelly
        }
    }

    /**
     * Calculate edge decay factor based on forecast age
     * Exponential decay with 1-minute half-life
     */
    private calculateEdgeDecayFactor(forecastTimestamp?: Date): number {
        if (!forecastTimestamp) {
            return 0.5;  // Default medium decay
        }

        const ageMs = Date.now() - forecastTimestamp.getTime();
        
        // If too old, no edge
        if (ageMs > this.MAX_EDGE_AGE_MS) {
            return 0.1;
        }
        
        // Exponential decay: factor = 0.5^(age/half_life)
        const decayFactor = Math.exp(-ageMs / this.EDGE_DECAY_HALF_LIFE_MS * Math.LN2);
        
        // Ensure minimum factor of 0.3
        return Math.max(0.3, decayFactor);
    }

    /**
     * Main entry point: Optimize entry for a detected edge
     * Now includes dynamic Kelly sizing and edge decay modeling
     */
    optimizeEntry(
        edge: CalculatedEdge, 
        orderBook?: OrderBook,
        forecastTimestamp?: Date,
        marketVolume24h?: number,
        sigma?: number  // Statistical significance for dynamic Kelly
    ): EntrySignal {
        const startTime = Date.now();
        
        // 1. Analyze market liquidity
        const liquidity = this.analyzeLiquidity(orderBook);
        
        // 2. Calculate volatility metrics
        const volatility = this.calculateVolatility(edge.marketId);
        
        // 3. Calculate urgency factor based on forecast freshness
        const urgencyFactor = this.calculateUrgencyFactor(forecastTimestamp);
        
        // 4. Calculate edge decay factor
        const edgeDecayFactor = this.calculateEdgeDecayFactor(forecastTimestamp);
        
        // 5. Determine Kelly fraction based on sigma and confidence
        const effectiveSigma = sigma ?? edge.confidence * 3;  // Approximate sigma from confidence
        const kellyFraction = this.getDynamicKellyFraction(effectiveSigma, edge.isGuaranteed);
        
        // 6. Calculate optimal position size using dynamic Kelly Criterion
        const kellyInputs = this.buildKellyInputs(edge, volatility);
        const baseKelly = this.calculateFullKelly(kellyInputs);
        
        // 7. Apply volatility adjustment
        const volatilityMultiplier = this.getVolatilityMultiplier(volatility.volatilityRegime);
        
        // 8. Apply liquidity constraints
        const liquidityConstrainedSize = this.applyLiquidityConstraints(
            this.maxPositionSize * baseKelly * edge.confidence,
            liquidity,
            orderBook
        );
        
        // 9. Calculate final target size with all factors
        let targetSize = liquidityConstrainedSize 
            * volatilityMultiplier 
            * urgencyFactor 
            * edgeDecayFactor
            * (kellyFraction / this.KELLY_FRACTION_MEDIUM_CONFIDENCE);  // Scale by dynamic Kelly ratio
        
        // 10. Fast path for guaranteed outcomes
        if (edge.isGuaranteed) {
            targetSize = this.maxPositionSize 
                * (config.guaranteedPositionMultiplier * 1.5)  // 3x instead of 2x
                * urgencyFactor 
                * edgeDecayFactor;
        }
        
        // 11. Clamp to min/max
        const absoluteMax = this.maxPositionSize * (config.guaranteedPositionMultiplier * 1.5);
        targetSize = Math.max(5, Math.min(absoluteMax, targetSize));
        
        // 12. Calculate market impact
        const marketImpact = this.marketImpactModel.estimateImpact(
            targetSize,
            marketVolume24h || 100000,  // Default $100k daily volume
            liquidity.depthScore
        );
        
        // 13. Determine if we should scale in
        const scaleInOrders = targetSize > this.SCALE_IN_THRESHOLD 
            ? this.buildScaleInOrders(targetSize, edge, liquidity, urgencyFactor)
            : undefined;
        
        // 14. Calculate expected slippage
        const expectedSlippage = this.marketModel.estimateSlippage(edge.marketId, targetSize);
        
        // 15. Build partial exit triggers for high-confidence trades
        const partialExitTriggers = this.buildPartialExitTriggers(effectiveSigma, volatility.volatilityRegime);
        
        const signal: EntrySignal = {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(targetSize.toFixed(2)),
            orderType: urgencyFactor > 0.8 ? 'MARKET' : 'LIMIT',
            priceLimit: this.calculateOptimalLimitPrice(edge, liquidity, urgencyFactor),
            urgency: this.determineUrgency(urgencyFactor, edge.isGuaranteed),
            reason: this.buildReason(edge, volatility, liquidity, baseKelly, urgencyFactor, effectiveSigma, edgeDecayFactor),
            confidence: edge.confidence * liquidity.depthScore,
            estimatedEdge: edge.adjustedEdge - marketImpact - expectedSlippage,
            isGuaranteed: edge.isGuaranteed,
            scaleInOrders,
            urgencyFactor: parseFloat(urgencyFactor.toFixed(3)),
            expectedSlippage: parseFloat(expectedSlippage.toFixed(4)),
            marketImpact: parseFloat(marketImpact.toFixed(4)),
            kellyFraction: parseFloat(kellyFraction.toFixed(3)),
            sigma: effectiveSigma,
            partialExitTriggers
        };
        
        const duration = Date.now() - startTime;
        if (duration > 5) {
            logger.warn(`[EntryOptimizer] Slow optimization: ${duration}ms`);
        }
        
        return signal;
    }

    /**
     * Build partial exit triggers based on sigma and volatility regime
     */
    private buildPartialExitTriggers(
        sigma: number, 
        regime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'
    ): PartialExitTrigger[] {
        const triggers: PartialExitTrigger[] = [];
        
        if (sigma >= 2.0 && regime !== 'EXTREME') {
            // High confidence, non-extreme volatility: Take 50% at 5%, let rest run
            triggers.push({
                percentOfPosition: 0.5,
                profitThreshold: 0.05,
                orderType: 'LIMIT'
            });
        } else if (sigma >= 1.0) {
            // Medium confidence: Take 30% at 4%, let rest run
            triggers.push({
                percentOfPosition: 0.3,
                profitThreshold: 0.04,
                orderType: 'LIMIT'
            });
        }
        
        return triggers;
    }

    /**
     * Analyze order book depth and liquidity
     */
    analyzeLiquidity(orderBook?: OrderBook): OrderBookDepth {
        if (!orderBook) {
            return {
                totalBidDepth: 0,
                totalAskDepth: 0,
                spread: 0.02,  // Assume 2% spread
                bestBid: 0.49,
                bestAsk: 0.51,
                depthScore: 0.5  // Neutral
            };
        }

        // Calculate total depth on each side
        const totalBidDepth = orderBook.bids.reduce((sum, bid) => {
            return sum + parseFloat(bid.size) * parseFloat(bid.price);
        }, 0);

        const totalAskDepth = orderBook.asks.reduce((sum, ask) => {
            return sum + parseFloat(ask.size) * parseFloat(ask.price);
        }, 0);

        const bestBid = orderBook.bids.length > 0 ? parseFloat(orderBook.bids[0].price) : 0;
        const bestAsk = orderBook.asks.length > 0 ? parseFloat(orderBook.asks[0].price) : 1;
        const spread = bestAsk - bestBid;

        // Calculate depth score (0-1)
        // More depth = better liquidity = higher score
        const avgDepth = (totalBidDepth + totalAskDepth) / 2;
        const depthScore = Math.min(1, avgDepth / 10000);  // $10k = full score

        return {
            totalBidDepth,
            totalAskDepth,
            spread,
            bestBid,
            bestAsk,
            depthScore
        };
    }

    /**
     * Calculate volatility metrics for a market
     */
    calculateVolatility(marketId: string): VolatilityMetrics {
        const velocity = this.marketModel.getPriceVelocity(marketId, 'yes');
        
        // Calculate price volatility based on velocity
        const priceVolatility = Math.abs(velocity);
        
        // Determine volatility regime
        let volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
        if (priceVolatility < this.VOLATILITY_LOW) {
            volatilityRegime = 'LOW';
        } else if (priceVolatility < this.VOLATILITY_HIGH) {
            volatilityRegime = 'MEDIUM';
        } else if (priceVolatility < this.VOLATILITY_EXTREME) {
            volatilityRegime = 'HIGH';
        } else {
            volatilityRegime = 'EXTREME';
        }

        return {
            priceVolatility,
            volumeVolatility: 0,  // Would need volume data
            recentVolatility: velocity,
            volatilityRegime
        };
    }

    /**
     * Calculate urgency factor based on forecast freshness
     * Higher urgency for fresh forecasts, decays over time
     */
    calculateUrgencyFactor(forecastTimestamp?: Date): number {
        if (!forecastTimestamp) {
            return 0.5;  // Default medium urgency
        }

        const ageMs = Date.now() - forecastTimestamp.getTime();
        
        // Urgency decays exponentially
        // 1.0 at t=0, 0.5 at URGENCY_DECAY_MS, approaching 0
        const urgency = Math.exp(-ageMs / this.URGENCY_DECAY_MS);
        
        // Ensure minimum urgency of 0.1 to still trade older signals
        return Math.max(0.1, urgency);
    }

    /**
     * Build Kelly Criterion inputs from edge and market conditions
     */
    private buildKellyInputs(edge: CalculatedEdge, volatility: VolatilityMetrics): KellyInputs {
        const winProbability = edge.confidence;
        const lossProbability = 1 - winProbability;
        
        // Adjust win/loss based on edge size and volatility
        // Higher edge = higher potential win
        // Higher volatility = higher potential loss (wider stops)
        const baseWin = edge.adjustedEdge * 2;  // Simplified: 2x edge as win
        const baseLoss = 1 + (volatility.priceVolatility * 10);  // Volatility-adjusted loss
        
        const avgWin = Math.max(0.1, baseWin);
        const avgLoss = Math.min(1.0, baseLoss);
        
        return {
            winProbability,
            lossProbability,
            avgWin,
            avgLoss,
            winLossRatio: avgWin / avgLoss
        };
    }

    /**
     * Calculate full Kelly Criterion fraction
     * f* = (p*b - q) / b
     * where p = win probability, q = loss probability, b = win/loss ratio
     */
    calculateFullKelly(inputs: KellyInputs): number {
        const { winProbability, lossProbability, winLossRatio } = inputs;
        
        if (winLossRatio <= 0) {
            return 0;
        }
        
        // Full Kelly formula
        const kelly = (winProbability * winLossRatio - lossProbability) / winLossRatio;
        
        // Default to quarter-Kelly for safety if sigma not provided
        const kellyFraction = this.KELLY_FRACTION_MEDIUM_CONFIDENCE;
        const fractionalKelly = Math.max(0, kelly * kellyFraction);
        
        // Cap at reasonable maximum (50% of bankroll)
        return Math.min(0.5, fractionalKelly);
    }

    /**
     * Get position size multiplier based on volatility regime
     */
    private getVolatilityMultiplier(regime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'): number {
        switch (regime) {
            case 'LOW':
                return 1.2;  // Increase size in low volatility
            case 'MEDIUM':
                return 1.0;  // Normal sizing
            case 'HIGH':
                return 0.7;  // Reduce size in high volatility
            case 'EXTREME':
                return 0.4;  // Significantly reduce in extreme volatility
            default:
                return 1.0;
        }
    }

    /**
     * Apply liquidity constraints to position size
     */
    private applyLiquidityConstraints(
        desiredSize: number,
        liquidity: OrderBookDepth,
        orderBook?: OrderBook
    ): number {
        // C2: If no order book data, skip depth-based constraints entirely
        // (depth is 0 which would incorrectly constrain size to 0)
        if (!orderBook) {
            // Apply spread-based reduction only
            if (liquidity.spread > 0.05) {
                return desiredSize * 0.7;
            }
            return desiredSize;
        }

        // Don't exceed 10% of order book depth on either side
        const maxSizeFromDepth = Math.min(
            liquidity.totalBidDepth * 0.1,
            liquidity.totalAskDepth * 0.1
        );
        
        // If order book is thin, be more conservative
        if (liquidity.depthScore < 0.3) {
            return Math.min(desiredSize * 0.5, maxSizeFromDepth);
        }
        
        // If spread is wide, reduce size
        if (liquidity.spread > 0.05) {
            return Math.min(desiredSize * 0.7, maxSizeFromDepth);
        }
        
        return Math.min(desiredSize, maxSizeFromDepth * 2);
    }

    /**
     * Build scale-in orders for large positions
     */
    private buildScaleInOrders(
        totalSize: number,
        edge: CalculatedEdge,
        liquidity: OrderBookDepth,
        urgencyFactor: number
    ): ScaleInOrder[] {
        const numTranches = Math.min(
            this.MAX_SCALE_IN_TRANCHES,
            Math.ceil(totalSize / this.SCALE_IN_THRESHOLD)
        );
        
        const trancheSize = totalSize / numTranches;
        const orders: ScaleInOrder[] = [];
        
        // First tranche is immediate
        orders.push({
            size: parseFloat(trancheSize.toFixed(2)),
            price: edge.side === 'yes' ? liquidity.bestAsk : liquidity.bestBid,
            delayMs: 0,
            orderType: urgencyFactor > 0.8 ? 'MARKET' : 'LIMIT'
        });
        
        // Subsequent tranches with delays
        for (let i = 1; i < numTranches; i++) {
            // Slightly better prices for later tranches (try to get filled on pullbacks)
            const priceImprovement = i * 0.005;  // 0.5% better each tranche
            
            orders.push({
                size: parseFloat(trancheSize.toFixed(2)),
                price: edge.side === 'yes' 
                    ? liquidity.bestAsk - priceImprovement
                    : liquidity.bestBid + priceImprovement,
                delayMs: i * 2000,  // 2 second delays between tranches
                orderType: 'LIMIT'
            });
        }
        
        return orders;
    }

    /**
     * Calculate optimal limit price based on urgency and liquidity
     */
    private calculateOptimalLimitPrice(
        edge: CalculatedEdge,
        liquidity: OrderBookDepth,
        urgencyFactor: number
    ): number | undefined {
        // For high urgency, use market orders (no limit)
        if (urgencyFactor > 0.9) {
            return undefined;
        }
        
        // For medium urgency, use current best price
        if (urgencyFactor > 0.5) {
            return edge.side === 'yes' ? liquidity.bestAsk : liquidity.bestBid;
        }
        
        // For low urgency, try to get better fill
        const improvement = 0.01 * (1 - urgencyFactor);  // Up to 1% improvement
        return edge.side === 'yes'
            ? liquidity.bestAsk - improvement
            : liquidity.bestBid + improvement;
    }

    /**
     * Determine urgency level for the signal
     */
    private determineUrgency(urgencyFactor: number, isGuaranteed: boolean): 'LOW' | 'MEDIUM' | 'HIGH' {
        if (isGuaranteed || urgencyFactor > 0.8) {
            return 'HIGH';
        }
        if (urgencyFactor > 0.4) {
            return 'MEDIUM';
        }
        return 'LOW';
    }

    /**
     * Build detailed reason string
     */
    private buildReason(
        edge: CalculatedEdge,
        volatility: VolatilityMetrics,
        liquidity: OrderBookDepth,
        kellyFraction: number,
        urgencyFactor: number,
        sigma?: number,
        edgeDecay?: number
    ): string {
        const parts = [
            `${edge.reason}`,
            `Edge: ${(edge.adjustedEdge * 100).toFixed(1)}%`,
            `Kelly: ${(kellyFraction * 100).toFixed(1)}%`,
            `Vol: ${volatility.volatilityRegime}`,
            `Liq: ${(liquidity.depthScore * 100).toFixed(0)}%`,
            `Urgency: ${(urgencyFactor * 100).toFixed(0)}%`
        ];
        
        if (sigma !== undefined) {
            parts.push(`Sigma: ${sigma.toFixed(1)}σ`);
        }
        
        if (edgeDecay !== undefined) {
            parts.push(`Decay: ${(edgeDecay * 100).toFixed(0)}%`);
        }
        
        if (edge.isGuaranteed) {
            parts.push('(GUARANTEED)');
        }
        
        return parts.join(' | ');
    }

    /**
     * Update max position size dynamically
     */
    setMaxPositionSize(size: number): void {
        this.maxPositionSize = size;
        logger.info(`[EntryOptimizer] Max position size updated: $${size}`);
    }

    /**
     * Get current configuration
     */
    getConfig(): {
        maxPositionSize: number;
        kellyFractions: { high: number; medium: number; low: number; guaranteed: number };
        scaleInThreshold: number;
        urgencyDecayMs: number;
    } {
        return {
            maxPositionSize: this.maxPositionSize,
            kellyFractions: {
                high: this.KELLY_FRACTION_HIGH_CONFIDENCE,
                medium: this.KELLY_FRACTION_MEDIUM_CONFIDENCE,
                low: this.KELLY_FRACTION_LOW_CONFIDENCE,
                guaranteed: this.KELLY_FRACTION_GUARANTEED
            },
            scaleInThreshold: this.SCALE_IN_THRESHOLD,
            urgencyDecayMs: this.URGENCY_DECAY_MS
        };
    }
}

export default EntryOptimizer;
