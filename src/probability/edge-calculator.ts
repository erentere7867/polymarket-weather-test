/**
 * Edge Calculator
 * Combines Bayesian probability and Market factors to determine true trading edge
 * 
 * Updated to include transaction costs (fees, spread) and safety margins
 * based on confidence levels (sigma).
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { MarketModel } from './market-model.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

export interface CalculatedEdge {
    marketId: string;
    side: 'yes' | 'no';
    rawEdge: number;      // Prob - Price
    adjustedEdge: number; // After slippage, fees, spread, and safety margin
    confidence: number;   // 0-1
    KellyFraction: number; // Recommended position size %
    reason: string;
    isGuaranteed: boolean; // Whether this is a near-certain outcome
    costBreakdown?: EdgeCostBreakdown; // Detailed cost breakdown for debugging
}

export interface EdgeCostBreakdown {
    slippage: number;
    fees: number;
    spread: number;
    safetyMargin: number;
    totalCosts: number;
    sigmaLevel: 'high' | 'medium' | 'low' | 'guaranteed';
}

export interface EdgeCalculationOptions {
    sigma?: number;           // Confidence level in standard deviations
    tradeSizeUsd?: number;    // Trade size in USD for fee calculation
    skipCosts?: boolean;      // Skip all cost adjustments (for guaranteed outcomes)
    confidence?: number;      // Confidence score from strategy (0-1), replaces probability-based confidence
}

export class EdgeCalculator {
    private marketModel: MarketModel;
    private minEdgeThreshold: number;

    constructor(marketModel: MarketModel, minEdgeThreshold: number = 0.10) {
        this.marketModel = marketModel;
        this.minEdgeThreshold = minEdgeThreshold;
    }

    /**
     * Get safety margin based on sigma (confidence level)
     * Higher sigma = higher confidence = lower safety margin needed
     */
    private getSafetyMargin(sigma: number | undefined, isGuaranteed: boolean): { margin: number; level: 'high' | 'medium' | 'low' | 'guaranteed' } {
        if (isGuaranteed) {
            return { margin: 0, level: 'guaranteed' };
        }
        
        // Default to low confidence if sigma not provided
        const effectiveSigma = sigma ?? 0;
        
        if (effectiveSigma >= 3.0) {
            // High confidence: 3+ sigma (99.87%+)
            return { margin: config.SAFETY_MARGIN_HIGH_CONFIDENCE, level: 'high' };
        } else if (effectiveSigma >= 2.0) {
            // Medium confidence: 2-3 sigma (95-99.87%)
            return { margin: config.SAFETY_MARGIN_MEDIUM_CONFIDENCE, level: 'medium' };
        } else {
            // Low confidence: <2 sigma (<95%)
            return { margin: config.SAFETY_MARGIN_LOW_CONFIDENCE, level: 'low' };
        }
    }

    /**
     * Calculate all costs associated with a trade
     * Note: Polymarket does NOT charge transaction fees, so fees are always 0
     */
    private calculateCosts(
        marketId: string,
        tradeSizeUsd: number,
        sigma: number | undefined,
        isGuaranteed: boolean
    ): EdgeCostBreakdown {
        // For guaranteed outcomes, skip all costs (speed matters most)
        if (isGuaranteed) {
            return {
                slippage: 0,
                fees: 0,
                spread: 0,
                safetyMargin: 0,
                totalCosts: 0,
                sigmaLevel: 'guaranteed'
            };
        }

        // Calculate slippage using market model
        const slippage = this.marketModel.estimateSlippage(marketId, tradeSizeUsd);
        
        // Polymarket does NOT charge transaction fees
        const fees = 0;
        
        // Get bid-ask spread estimate
        const spread = config.BID_ASK_SPREAD_ESTIMATE;
        
        // Get safety margin based on confidence level
        const { margin: safetyMargin, level: sigmaLevel } = this.getSafetyMargin(sigma, isGuaranteed);
        
        // New formula: adjustedEdge = rawEdge - slippage - spread - safetyMargin (no fees)
        const totalCosts = slippage + fees + spread + safetyMargin;
        
        return {
            slippage,
            fees,
            spread,
            safetyMargin,
            totalCosts,
            sigmaLevel
        };
    }

    /**
     * Log the cost breakdown for debugging
     * Note: Polymarket has no transaction fees
     */
    private logCostBreakdown(
        marketId: string,
        rawEdge: number,
        costs: EdgeCostBreakdown,
        adjustedEdge: number,
        side: 'yes' | 'no'
    ): void {
        logger.info(`[EdgeCalculator] Cost breakdown for market ${marketId} (${side.toUpperCase()}):`);
        logger.info(`  Raw edge:           ${(rawEdge * 100).toFixed(2)}%`);
        logger.info(`  - Slippage:         ${(costs.slippage * 100).toFixed(2)}%`);
        logger.info(`  - Fees:             $0 (Polymarket has no fees)`);
        logger.info(`  - Spread:           ${(costs.spread * 100).toFixed(2)}%`);
        logger.info(`  - Safety margin:    ${(costs.safetyMargin * 100).toFixed(2)}% (${costs.sigmaLevel})`);
        logger.info(`  = Adjusted edge:    ${(adjustedEdge * 100).toFixed(2)}%`);
    }

    /**
     * Calculate trading edge with full cost accounting
     * 
     * @param market - The parsed weather market
     * @param forecastProbability - Model's forecast probability (0-1)
     * @param marketPriceYes - Current market price for YES
     * @param marketPriceNo - Current market price for NO
     * @param options - Optional parameters for edge calculation
     * @returns CalculatedEdge if edge is sufficient, null otherwise
     */
    calculateEdge(
        market: ParsedWeatherMarket,
        forecastProbability: number,
        marketPriceYes: number,
        marketPriceNo: number,
        options?: EdgeCalculationOptions
    ): CalculatedEdge | null {

        // Extract options with defaults
        const sigma = options?.sigma;
        const tradeSizeUsd = options?.tradeSizeUsd ?? 100; // Default $100 position
        const skipCosts = options?.skipCosts ?? false;

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

        // 2. Determine if this is a guaranteed outcome
        const isGuaranteed = forecastProbability >= 0.99 || forecastProbability <= 0.01;
        const shouldSkipCosts = skipCosts || isGuaranteed;

        // 3. Calculate all costs
        const costs = this.calculateCosts(
            market.market.id,
            tradeSizeUsd,
            sigma,
            shouldSkipCosts
        );

        // 4. Calculate adjusted edge: raw - slippage - fees - spread - safety margin
        const adjustedEdge = rawEdge - costs.totalCosts;

        // 5. Log the cost breakdown for debugging
        this.logCostBreakdown(market.market.id, rawEdge, costs, adjustedEdge, side);

        // 6. Validation: Check minimum adjusted edge threshold
        const minAdjustedEdge = config.MIN_ADJUSTED_EDGE_THRESHOLD;
        
        // For guaranteed outcomes, allow ANY positive edge (0%)
        const effectiveThreshold = isGuaranteed ? 0.00 : Math.max(this.minEdgeThreshold, minAdjustedEdge);
        
        if (adjustedEdge < effectiveThreshold) {
            // Log warning if raw edge is positive but adjusted edge is below threshold
            if (rawEdge > 0 && adjustedEdge < effectiveThreshold) {
                logger.warn(
                    `[EdgeCalculator] Market ${market.market.id}: Raw edge ${(rawEdge * 100).toFixed(2)}% ` +
                    `is positive but adjusted edge ${(adjustedEdge * 100).toFixed(2)}% ` +
                    `is below minimum threshold ${(effectiveThreshold * 100).toFixed(2)}%`
                );
            }
            return null;
        }

        // 7. Calculate Kelly Criterion
        // f = (bp - q) / b
        // where b = odds - 1 (decimal odds = 1/price)
        // p = probability
        // q = 1-p

        // Correct Kelly for binary options (price P, prob W):
        // f = W/P - (1-W)/(1-P)
        const probWin = side === 'yes' ? forecastProbability : (1 - forecastProbability);
        const payoutRatio = (1 - price) / price; // Revenue/Risk

        let kelly = 0;
        if (payoutRatio > 0) {
            kelly = probWin - ((1 - probWin) / payoutRatio);
        }

        // Fractional Kelly for safety (Half-Kelly or Quarter-Kelly)
        const safetyMultiplier = 0.25;
        const finalKelly = Math.max(0, kelly * safetyMultiplier);

        // 8. Build and return the result
        // Use confidence from strategy (stability-based), fallback to 0.5 if not provided
        const strategyConfidence = options?.confidence ?? 0.5;

        const result: CalculatedEdge = {
            marketId: market.market.id,
            side,
            rawEdge,
            adjustedEdge,
            // Confidence comes from strategy (stability-based), not calculated from probability
            confidence: isGuaranteed ? 1.0 : strategyConfidence,
            KellyFraction: isGuaranteed ? safetyMultiplier : finalKelly, // Higher Kelly for guaranteed
            reason: `Forecast ${(probWin * 100).toFixed(1)}% vs Price ${(price * 100).toFixed(1)}%${isGuaranteed ? ' (GUARANTEED)' : ''}`,
            isGuaranteed,
            costBreakdown: costs
        };

        logger.info(
            `[EdgeCalculator] Trade opportunity: ${market.market.id} ${side.toUpperCase()} ` +
            `| Raw: ${(rawEdge * 100).toFixed(2)}% → Adj: ${(adjustedEdge * 100).toFixed(2)}% ` +
            `| Kelly: ${(result.KellyFraction * 100).toFixed(1)}%${isGuaranteed ? ' | GUARANTEED' : ''}`
        );

        return result;
    }

    /**
     * Quick edge check without full calculation
     * Useful for filtering opportunities before detailed analysis
     * 
     * @param forecastProbability - Model's forecast probability
     * @param marketPriceYes - Current market price for YES
     * @param marketPriceNo - Current market price for NO
     * @param sigma - Optional confidence level in standard deviations
     * @returns Estimated adjusted edge (conservative estimate)
     */
    quickEdgeEstimate(
        forecastProbability: number,
        marketPriceYes: number,
        marketPriceNo: number,
        sigma?: number
    ): number {
        // Calculate raw edge
        const edgeYes = forecastProbability - marketPriceYes;
        const edgeNo = (1 - forecastProbability) - marketPriceNo;
        const rawEdge = Math.max(edgeYes, edgeNo);

        // For guaranteed outcomes, return raw edge
        if (forecastProbability >= 0.99 || forecastProbability <= 0.01) {
            return rawEdge;
        }

        // Get safety margin
        const { margin: safetyMargin } = this.getSafetyMargin(sigma, false);

        // Estimate total costs conservatively (no fees - Polymarket has no transaction fees)
        const estimatedCosts =
            0.01 + // Slippage estimate
            config.BID_ASK_SPREAD_ESTIMATE +
            safetyMargin;

        return rawEdge - estimatedCosts;
    }
}
