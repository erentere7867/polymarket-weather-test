/**
 * Order Executor
 * Converts trading opportunities into orders and manages execution
 * 
 * Price Handling Strategy:
 * - Uses LIVE prices at execution time for real market execution
 * - Re-validates edge calculation with current prices before executing
 * - Skips trade if edge is no longer favorable with current prices
 * - Maintains price drift protection as safety mechanism
 */

import { TradingClient } from '../polymarket/clob-client.js';
import { TradingOpportunity, TradeOrder } from '../polymarket/types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface ExecutionResult {
    opportunity: TradingOpportunity;
    executed: boolean;
    orderId?: string;
    error?: string;
}

// Cooldown period to prevent duplicate trades on same market (ms)
const TRADE_COOLDOWN_MS = 30000; // 30 seconds - allow faster re-entry

// Maximum concurrent orders for burst execution
const MAX_CONCURRENT_ORDERS = 5;

// Maximum acceptable price drift between detection and execution (in dollars)
const MAX_PRICE_DRIFT = 0.15; // 15 cents - allow more price movement during validation

// Minimum edge threshold for execution (can be different from detection threshold)
const MIN_EXECUTION_EDGE = 0.02; // 2% minimum edge to execute with live prices

// Edge degradation tolerance - how much edge can degrade and still execute
const EDGE_DEGRADATION_TOLERANCE = 0.05; // 5% tolerance - allow more edge degradation

export class OrderExecutor {
    private tradingClient: TradingClient;
    private executedOrderIds: Set<string> = new Set();
    private recentlyTradedMarkets: Map<string, Date> = new Map();

    constructor(tradingClient: TradingClient) {
        this.tradingClient = tradingClient;
    }

    /**
     * Execute a trade for an opportunity
     * 
     * Uses LIVE prices at execution time with edge re-validation:
     * 1. Gets current market price at execution time
     * 2. Re-calculates edge with current price
     * 3. Only executes if edge is still favorable
     * 4. Maintains price drift protection as safety mechanism
     */
    async executeOpportunity(opportunity: TradingOpportunity): Promise<ExecutionResult> {
        if (opportunity.action === 'none') {
            return { opportunity, executed: false, error: 'No action to take' };
        }

        try {
            // Get LIVE prices at execution time
            const isBuyYes = opportunity.action === 'buy_yes';
            const tokenId = isBuyYes ? opportunity.market.yesTokenId : opportunity.market.noTokenId;
            
            // Snapshot prices from detection time (for reference)
            const snapshotYesPrice = opportunity.snapshotYesPrice;
            const snapshotNoPrice = opportunity.snapshotNoPrice;
            const snapshotPrice = isBuyYes ? snapshotYesPrice : snapshotNoPrice;
            
            // LIVE prices at execution time
            const liveYesPrice = opportunity.market.yesPrice;
            const liveNoPrice = opportunity.market.noPrice;
            const livePrice = isBuyYes ? liveYesPrice : liveNoPrice;
            
            // Calculate price drift between detection and execution
            const priceDrift = Math.abs(livePrice - snapshotPrice);
            const snapshotAge = Date.now() - opportunity.snapshotTimestamp.getTime();
            
            // Price drift protection: if price moved too much, skip the trade
            // This protects against extreme volatility or stale opportunities
            if (priceDrift > MAX_PRICE_DRIFT) {
                logger.warn('Skipping trade due to excessive price drift', {
                    market: opportunity.market.market.question.substring(0, 50),
                    action: opportunity.action,
                    snapshotPrice: snapshotPrice.toFixed(3),
                    livePrice: livePrice.toFixed(3),
                    drift: priceDrift.toFixed(3),
                    maxDrift: MAX_PRICE_DRIFT.toFixed(3),
                    snapshotAgeMs: snapshotAge,
                });
                return { 
                    opportunity, 
                    executed: false, 
                    error: `Price drift too high: ${priceDrift.toFixed(3)} > ${MAX_PRICE_DRIFT}` 
                };
            }
            
            // Edge re-validation: recalculate edge with LIVE prices
            // Original edge: forecastProbability - marketProbability (at detection time)
            // New edge: forecastProbability - liveMarketProbability (at execution time)
            const liveMarketProbability = liveYesPrice; // YES price = market's implied probability
            const originalEdge = opportunity.edge;
            const liveEdge = opportunity.forecastProbability - liveMarketProbability;
            const absLiveEdge = Math.abs(liveEdge);
            
            // Determine if we should still execute based on live edge
            // For buy_yes: edge > 0 means forecast > market (underpriced YES)
            // For buy_no: we need to check the NO edge
            let shouldExecute = false;
            let liveEdgeForAction = 0;
            
            if (isBuyYes) {
                // Buying YES: positive edge means forecast > market price
                liveEdgeForAction = liveEdge;
                shouldExecute = liveEdge > MIN_EXECUTION_EDGE;
            } else {
                // Buying NO: we need to calculate NO edge
                // NO price = 1 - YES price, so NO edge = (1 - forecast) - (1 - market) = market - forecast = -edge
                liveEdgeForAction = -liveEdge;
                shouldExecute = liveEdgeForAction > MIN_EXECUTION_EDGE;
            }
            
            // Additional check: edge degradation
            // If edge degraded significantly from original detection, be cautious
            const edgeDegradation = Math.abs(originalEdge) - Math.abs(liveEdgeForAction);
            const edgeDegradedTooMuch = edgeDegradation > EDGE_DEGRADATION_TOLERANCE;
            
            if (!shouldExecute) {
                logger.warn('Skipping trade - edge no longer favorable with live prices', {
                    market: opportunity.market.market.question.substring(0, 50),
                    action: opportunity.action,
                    originalEdge: (originalEdge * 100).toFixed(2) + '%',
                    liveEdge: (liveEdgeForAction * 100).toFixed(2) + '%',
                    minEdge: (MIN_EXECUTION_EDGE * 100).toFixed(2) + '%',
                    snapshotPrice: snapshotPrice.toFixed(3),
                    livePrice: livePrice.toFixed(3),
                });
                return { 
                    opportunity, 
                    executed: false, 
                    error: `Live edge ${(liveEdgeForAction * 100).toFixed(2)}% below minimum ${(MIN_EXECUTION_EDGE * 100).toFixed(2)}%` 
                };
            }
            
            if (edgeDegradedTooMuch) {
                logger.warn('Skipping trade - edge degraded significantly', {
                    market: opportunity.market.market.question.substring(0, 50),
                    action: opportunity.action,
                    originalEdge: (originalEdge * 100).toFixed(2) + '%',
                    liveEdge: (liveEdgeForAction * 100).toFixed(2) + '%',
                    degradation: (edgeDegradation * 100).toFixed(2) + '%',
                    maxDegradation: (EDGE_DEGRADATION_TOLERANCE * 100).toFixed(2) + '%',
                });
                return { 
                    opportunity, 
                    executed: false, 
                    error: `Edge degraded by ${(edgeDegradation * 100).toFixed(2)}% > ${(EDGE_DEGRADATION_TOLERANCE * 100).toFixed(2)}%` 
                };
            }

            // Calculate position size based on LIVE edge
            const positionSize = this.calculatePositionSize(opportunity, liveEdgeForAction);

            if (positionSize <= 0) {
                return { opportunity, executed: false, error: 'Position size too small' };
            }

            // For guaranteed outcomes, use more aggressive pricing to ensure fills
            const isGuaranteed = opportunity.isGuaranteed || false;
            const priceIncrement = isGuaranteed ? 0.05 : 0.01; // 5¢ for guaranteed, 1¢ otherwise

            // Build order using LIVE price (not snapshot price)
            const order: TradeOrder = {
                tokenId,
                side: 'BUY',
                price: Math.min(livePrice + priceIncrement, 0.99),
                size: positionSize,
                orderType: 'GTC', // Good til cancelled
            };

            logger.info('Executing trade with live price validation', {
                market: opportunity.market.market.question.substring(0, 50),
                action: opportunity.action,
                originalEdge: (originalEdge * 100).toFixed(2) + '%',
                liveEdge: (liveEdgeForAction * 100).toFixed(2) + '%',
                snapshotPrice: snapshotPrice.toFixed(3),
                livePrice: livePrice.toFixed(3),
                priceDrift: priceDrift.toFixed(3),
                orderPrice: order.price.toFixed(3),
                size: order.size,
                simulated: config.simulationMode,
            });

            // Place order
            const result = await this.tradingClient.placeOrder(order);

            if (result) {
                this.executedOrderIds.add(result.orderId);
                // Track this market as recently traded
                this.recentlyTradedMarkets.set(opportunity.market.market.id, new Date());
                return {
                    opportunity,
                    executed: true,
                    orderId: result.orderId,
                };
            }

            return { opportunity, executed: false, error: 'Order placement returned null' };
        } catch (error) {
            logger.error('Order execution failed', { error: (error as Error).message });
            return {
                opportunity,
                executed: false,
                error: (error as Error).message,
            };
        }
    }

    /**
     * Calculate position size based on Kelly criterion (simplified)
     * Uses the provided edge (which may be live edge at execution time)
     */
    private calculatePositionSize(opportunity: TradingOpportunity, edgeOverride?: number): number {
        const maxSize = config.maxPositionSize;
        // Use provided edge (live edge) or fall back to original edge from opportunity
        const edge = edgeOverride !== undefined ? Math.abs(edgeOverride) : Math.abs(opportunity.edge);
        const confidence = opportunity.confidence;

        // Kelly fraction = (bp - q) / b
        // Simplified: edge * confidence
        const kellyFraction = edge * confidence;

        // Use half Kelly for safety
        const halfKelly = kellyFraction * 0.5;

        // Calculate USDC amount
        const usdcAmount = maxSize * Math.min(halfKelly * 10, 1); // Scale and cap at max

        // Calculate number of shares (price determines how many shares per USDC)
        // Use live price for position sizing
        const price = opportunity.action === 'buy_yes'
            ? opportunity.market.yesPrice
            : opportunity.market.noPrice;

        if (price <= 0) return 0;

        const shares = Math.floor(usdcAmount / price);

        // Minimum 1 share, maximum based on max position size
        return Math.max(1, Math.min(shares, Math.floor(maxSize / price)));
    }

    /**
     * Execute multiple opportunities with rate limiting
     */
    async executeOpportunities(opportunities: TradingOpportunity[]): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];

        // Filter out recently traded markets first
        // Also filter out opportunities with significant price drift (>5 cents)
        const eligibleOpportunities = opportunities.filter(opp => {
            const marketKey = opp.market.market.id;
            if (this.recentlyTraded(marketKey)) {
                logger.debug(`Skipping recently traded market: ${opp.market.market.question.substring(0, 40)}`);
                return false;
            }
            
            // Check for price drift - skip if price moved too much since detection
            const isBuyYes = opp.action === 'buy_yes';
            const snapshotPrice = isBuyYes ? opp.snapshotYesPrice : opp.snapshotNoPrice;
            const currentPrice = isBuyYes ? opp.market.yesPrice : opp.market.noPrice;
            const priceDrift = Math.abs(currentPrice - snapshotPrice);
            const maxAcceptableDrift = 0.15; // 15 cents max drift - aligned with MAX_PRICE_DRIFT
            
            if (priceDrift > maxAcceptableDrift) {
                logger.warn(`Skipping opportunity due to excessive price drift: ${opp.market.market.question.substring(0, 40)}`, {
                    snapshotPrice: snapshotPrice.toFixed(3),
                    currentPrice: currentPrice.toFixed(3),
                    drift: priceDrift.toFixed(3),
                });
                return false;
            }
            
            return true;
        });

        // OPTIMIZED: Execute opportunities in parallel with concurrency limit
        // This removes the 1-second delay between orders while maintaining rate limits
        const executionBatches: TradingOpportunity[][] = [];
        for (let i = 0; i < eligibleOpportunities.length; i += MAX_CONCURRENT_ORDERS) {
            executionBatches.push(eligibleOpportunities.slice(i, i + MAX_CONCURRENT_ORDERS));
        }
        
        for (const batch of executionBatches) {
            // Execute batch in parallel
            const batchResults = await Promise.all(
                batch.map(opp => this.executeOpportunity(opp))
            );
            results.push(...batchResults);
            
            // Minimal delay between batches (50ms) to prevent overwhelming the API
            if (executionBatches.indexOf(batch) < executionBatches.length - 1) {
                await this.delay(50);
            }
        }

        return results;
    }

    /**
     * Check if a market was recently traded (to avoid duplicate trades)
     * Enhanced with price awareness - allows re-entry if price has moved significantly
     */
    private recentlyTraded(marketKey: string, currentPrice?: number, previousPrice?: number): boolean {
        const lastTrade = this.recentlyTradedMarkets.get(marketKey);
        if (!lastTrade) return false;

        const elapsed = Date.now() - lastTrade.getTime();
        if (elapsed > TRADE_COOLDOWN_MS) {
            // Cooldown expired, clean up and allow trading
            this.recentlyTradedMarkets.delete(marketKey);
            return false;
        }

        // Price-aware cooldown: if price has moved significantly, allow re-entry
        // This prevents missing opportunities when market moves after our trade
        if (currentPrice !== undefined && previousPrice !== undefined) {
            const priceChange = Math.abs(currentPrice - previousPrice);
            const significantPriceMove = 0.03; // 3 cents is significant
            
            if (priceChange >= significantPriceMove) {
                logger.info(`Allowing re-entry for ${marketKey} due to price movement: ${priceChange.toFixed(3)}`);
                this.recentlyTradedMarkets.delete(marketKey);
                return false;
            }
        }

        return true; // Still in cooldown
    }

    /**
     * Get count of executed orders
     */
    getExecutedOrderCount(): number {
        return this.executedOrderIds.size;
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
