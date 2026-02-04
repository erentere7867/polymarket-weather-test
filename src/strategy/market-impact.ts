/**
 * Market Impact Model
 * 
 * Estimates price impact and slippage for different order sizes
 * using the square-root law of market impact:
 * 
 * impact = k * sqrt(order_size / daily_volume)
 * 
 * Where:
 * - k is a market-specific constant (typically 0.5-2.0)
 * - order_size is the size of our order
 * - daily_volume is the market's daily trading volume
 * 
 * Features:
 * - Price impact estimation based on order size and liquidity
 * - Slippage modeling for different position sizes
 * - Optimal order sizing to minimize market impact
 * - Impact decay modeling (how long impact lasts)
 */

import { logger } from '../logger.js';

export interface MarketImpactEstimate {
    immediateImpact: number;      // Immediate price impact (0-1)
    decayedImpact: number;        // Impact after decay period
    totalCost: number;            // Total cost including impact
    slippageEstimate: number;     // Estimated slippage
    recommendedMaxSize: number;   // Recommended maximum order size
    optimalChunkSize: number;     // Optimal size for single order
}

export interface LiquidityProfile {
    dailyVolume: number;          // 24h volume in USDC
    averageTradeSize: number;     // Average trade size
    bidDepth: number;             // Total bid depth
    askDepth: number;             // Total ask depth
    spread: number;               // Current spread (0-1)
    volatility: number;           // Price volatility
}

export interface OrderChunkingPlan {
    totalSize: number;
    chunks: Array<{
        size: number;
        delayMs: number;
        expectedImpact: number;
    }>;
    totalExpectedImpact: number;
    executionTimeMs: number;
}

export class MarketImpactModel {
    // Square-root law constant (calibrated for prediction markets)
    // Lower = more liquid, higher = less liquid
    private readonly IMPACT_CONSTANT_LOW = 0.3;      // Very liquid
    private readonly IMPACT_CONSTANT_MEDIUM = 0.8;   // Average
    private readonly IMPACT_CONSTANT_HIGH = 1.5;     // Illiquid
    
    // Impact decay parameters
    private readonly IMPACT_DECAY_HALF_LIFE_MS = 60000;  // 1 minute half-life
    
    // Slippage parameters
    private readonly BASE_SLIPPAGE = 0.001;  // 0.1% base slippage
    private readonly SLIPPAGE_PER_1000 = 0.002;  // Additional 0.2% per $1000
    
    // Optimal sizing parameters
    private readonly MAX_IMPACT_THRESHOLD = 0.02;  // 2% max acceptable impact
    private readonly TARGET_IMPACT = 0.01;  // 1% target impact

    /**
     * Estimate market impact for a given order size
     * Uses square-root law: impact = k * sqrt(order_size / daily_volume)
     */
    estimateImpact(
        orderSize: number,
        dailyVolume: number,
        liquidityScore: number = 0.5
    ): number {
        if (dailyVolume <= 0) {
            return 0.05;  // Default 5% impact for unknown volume
        }

        // Select impact constant based on liquidity score
        let k: number;
        if (liquidityScore > 0.7) {
            k = this.IMPACT_CONSTANT_LOW;
        } else if (liquidityScore > 0.3) {
            k = this.IMPACT_CONSTANT_MEDIUM;
        } else {
            k = this.IMPACT_CONSTANT_HIGH;
        }

        // Apply square-root law
        const participationRate = orderSize / dailyVolume;
        const impact = k * Math.sqrt(participationRate);

        // Cap impact at reasonable maximum
        return Math.min(impact, 0.20);
    }

    /**
     * Estimate complete market impact including all factors
     */
    estimateCompleteImpact(
        orderSize: number,
        liquidity: LiquidityProfile
    ): MarketImpactEstimate {
        // Calculate liquidity score from profile
        const liquidityScore = this.calculateLiquidityScore(liquidity);
        
        // Base impact from square-root law
        const immediateImpact = this.estimateImpact(
            orderSize,
            liquidity.dailyVolume,
            liquidityScore
        );
        
        // Add spread cost
        const spreadCost = liquidity.spread / 2;
        
        // Calculate slippage
        const slippageEstimate = this.estimateSlippage(orderSize, liquidity);
        
        // Total immediate cost
        const totalImmediateCost = immediateImpact + spreadCost + slippageEstimate;
        
        // Calculate decayed impact (after 5 minutes)
        const decayedImpact = this.calculateDecayedImpact(immediateImpact, 5 * 60 * 1000);
        
        // Calculate recommended max size
        const recommendedMaxSize = this.calculateRecommendedMaxSize(
            liquidity.dailyVolume,
            liquidityScore
        );
        
        // Calculate optimal chunk size
        const optimalChunkSize = this.calculateOptimalChunkSize(
            orderSize,
            liquidity.dailyVolume,
            liquidityScore
        );

        return {
            immediateImpact: parseFloat(immediateImpact.toFixed(4)),
            decayedImpact: parseFloat(decayedImpact.toFixed(4)),
            totalCost: parseFloat(totalImmediateCost.toFixed(4)),
            slippageEstimate: parseFloat(slippageEstimate.toFixed(4)),
            recommendedMaxSize: parseFloat(recommendedMaxSize.toFixed(2)),
            optimalChunkSize: parseFloat(optimalChunkSize.toFixed(2))
        };
    }

    /**
     * Estimate slippage for a given order size
     */
    estimateSlippage(orderSize: number, liquidity: LiquidityProfile): number {
        // Base slippage
        let slippage = this.BASE_SLIPPAGE;
        
        // Add size-based slippage
        const sizeFactor = orderSize / 1000;
        slippage += sizeFactor * this.SLIPPAGE_PER_1000;
        
        // Adjust for liquidity
        const liquidityAdjustment = 1 / (liquidityScore(liquidity) + 0.1);
        slippage *= liquidityAdjustment;
        
        // Adjust for volatility
        slippage *= (1 + liquidity.volatility * 10);
        
        return Math.min(slippage, 0.10);  // Cap at 10%
    }

    /**
     * Calculate optimal order size to minimize impact while maximizing fill probability
     */
    calculateOptimalOrderSize(
        desiredSize: number,
        dailyVolume: number,
        liquidityScore: number = 0.5
    ): number {
        // Find size that gives target impact
        let k: number;
        if (liquidityScore > 0.7) {
            k = this.IMPACT_CONSTANT_LOW;
        } else if (liquidityScore > 0.3) {
            k = this.IMPACT_CONSTANT_MEDIUM;
        } else {
            k = this.IMPACT_CONSTANT_HIGH;
        }

        // Rearrange square-root law: size = daily_volume * (target_impact / k)^2
        const optimalSize = dailyVolume * Math.pow(this.TARGET_IMPACT / k, 2);
        
        // Don't exceed desired size
        return Math.min(optimalSize, desiredSize);
    }

    /**
     * Create a chunking plan for large orders
     */
    createChunkingPlan(
        totalSize: number,
        liquidity: LiquidityProfile,
        maxTimeMs: number = 30000  // Default 30 seconds
    ): OrderChunkingPlan {
        const liquidityScore = this.calculateLiquidityScore(liquidity);
        const optimalChunk = this.calculateOptimalChunkSize(
            totalSize,
            liquidity.dailyVolume,
            liquidityScore
        );
        
        // Calculate number of chunks
        const numChunks = Math.ceil(totalSize / optimalChunk);
        
        // Calculate delay between chunks (distribute over maxTimeMs)
        const delayBetweenChunks = numChunks > 1 ? maxTimeMs / (numChunks - 1) : 0;
        
        const chunks: Array<{ size: number; delayMs: number; expectedImpact: number }> = [];
        let remainingSize = totalSize;
        
        for (let i = 0; i < numChunks && remainingSize > 0; i++) {
            const chunkSize = Math.min(optimalChunk, remainingSize);
            const expectedImpact = this.estimateImpact(
                chunkSize,
                liquidity.dailyVolume,
                liquidityScore
            );
            
            chunks.push({
                size: parseFloat(chunkSize.toFixed(2)),
                delayMs: i * delayBetweenChunks,
                expectedImpact: parseFloat(expectedImpact.toFixed(4))
            });
            
            remainingSize -= chunkSize;
        }
        
        // Calculate total expected impact (assuming some decay between chunks)
        let totalExpectedImpact = 0;
        for (let i = 0; i < chunks.length; i++) {
            const decayedImpact = this.calculateDecayedImpact(
                chunks[i].expectedImpact,
                i * delayBetweenChunks
            );
            totalExpectedImpact += decayedImpact;
        }
        
        return {
            totalSize: parseFloat(totalSize.toFixed(2)),
            chunks,
            totalExpectedImpact: parseFloat(totalExpectedImpact.toFixed(4)),
            executionTimeMs: chunks.length > 0 ? chunks[chunks.length - 1].delayMs : 0
        };
    }

    /**
     * Calculate how impact decays over time
     * Uses exponential decay: impact(t) = impact(0) * (0.5)^(t / half_life)
     */
    calculateDecayedImpact(initialImpact: number, timeMs: number): number {
        const decayFactor = Math.pow(0.5, timeMs / this.IMPACT_DECAY_HALF_LIFE_MS);
        return initialImpact * decayFactor;
    }

    /**
     * Check if order size is likely to cause excessive impact
     */
    isExcessiveImpact(orderSize: number, dailyVolume: number, liquidityScore: number = 0.5): boolean {
        const impact = this.estimateImpact(orderSize, dailyVolume, liquidityScore);
        return impact > this.MAX_IMPACT_THRESHOLD;
    }

    /**
     * Get recommended maximum order size for a market
     */
    getRecommendedMaxOrderSize(dailyVolume: number, liquidityScore: number = 0.5): number {
        return this.calculateRecommendedMaxSize(dailyVolume, liquidityScore);
    }

    /**
     * Estimate total execution cost including all factors
     */
    estimateTotalExecutionCost(
        orderSize: number,
        side: 'buy' | 'sell',
        liquidity: LiquidityProfile
    ): {
        marketImpact: number;
        spreadCost: number;
        slippage: number;
        totalCost: number;
        costBasis: number;
    } {
        const impact = this.estimateImpact(orderSize, liquidity.dailyVolume, this.calculateLiquidityScore(liquidity));
        const spreadCost = liquidity.spread / 2;
        const slippage = this.estimateSlippage(orderSize, liquidity);
        
        const totalCost = impact + spreadCost + slippage;
        
        // Cost basis adjustment
        const costBasis = side === 'buy' ? 1 + totalCost : 1 - totalCost;
        
        return {
            marketImpact: parseFloat(impact.toFixed(4)),
            spreadCost: parseFloat(spreadCost.toFixed(4)),
            slippage: parseFloat(slippage.toFixed(4)),
            totalCost: parseFloat(totalCost.toFixed(4)),
            costBasis: parseFloat(costBasis.toFixed(4))
        };
    }

    // ====================
    // Private Helper Methods
    // ====================

    private calculateLiquidityScore(liquidity: LiquidityProfile): number {
        // Composite liquidity score based on multiple factors
        const volumeScore = Math.min(1, liquidity.dailyVolume / 100000);  // $100k = full score
        const depthScore = Math.min(1, (liquidity.bidDepth + liquidity.askDepth) / 20000);
        const spreadScore = Math.max(0, 1 - liquidity.spread * 10);  // Lower spread = higher score
        
        // Weighted average
        return (volumeScore * 0.4 + depthScore * 0.4 + spreadScore * 0.2);
    }

    private calculateRecommendedMaxSize(dailyVolume: number, liquidityScore: number): number {
        // Find size that gives max acceptable impact
        let k: number;
        if (liquidityScore > 0.7) {
            k = this.IMPACT_CONSTANT_LOW;
        } else if (liquidityScore > 0.3) {
            k = this.IMPACT_CONSTANT_MEDIUM;
        } else {
            k = this.IMPACT_CONSTANT_HIGH;
        }

        // Rearrange: size = daily_volume * (max_impact / k)^2
        return dailyVolume * Math.pow(this.MAX_IMPACT_THRESHOLD / k, 2);
    }

    private calculateOptimalChunkSize(
        totalSize: number,
        dailyVolume: number,
        liquidityScore: number
    ): number {
        const optimalSingle = this.calculateOptimalOrderSize(totalSize, dailyVolume, liquidityScore);
        
        // For very large orders, use smaller chunks
        if (totalSize > optimalSingle * 3) {
            return optimalSingle;
        }
        
        // For medium orders, use 2-3 chunks
        if (totalSize > optimalSingle) {
            return totalSize / Math.ceil(totalSize / optimalSingle);
        }
        
        return totalSize;
    }
}

// Helper function for liquidity score calculation
function liquidityScore(liquidity: LiquidityProfile): number {
    const volumeScore = Math.min(1, liquidity.dailyVolume / 100000);
    const depthScore = Math.min(1, (liquidity.bidDepth + liquidity.askDepth) / 20000);
    const spreadScore = Math.max(0, 1 - liquidity.spread * 10);
    return (volumeScore * 0.4 + depthScore * 0.4 + spreadScore * 0.2);
}

export default MarketImpactModel;
