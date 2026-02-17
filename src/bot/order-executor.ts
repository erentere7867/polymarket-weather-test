/**
 * Order Executor
 * Executes trading opportunities with live price validation
 */

import { TradingClient } from '../polymarket/clob-client.js';
import { TradingOpportunity, TradeOrder } from '../polymarket/types.js';
import { DataStore } from '../realtime/data-store.js';
import { config, ORDER_CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { LatencyTracker } from '../realtime/latency-tracker.js';

interface ExecutionResult {
    opportunity: TradingOpportunity;
    executed: boolean;
    orderId?: string;
    error?: string;
    traceId?: string;  // Unique ID for end-to-end latency tracking
}

const TRADE_COOLDOWN_MS = ORDER_CONFIG.ORDER_COOLDOWN_MS;
const MAX_CONCURRENT_ORDERS = ORDER_CONFIG.MAX_CONCURRENT_ORDERS;
const MAX_PRICE_DRIFT = 0.15;
const MIN_EXECUTION_EDGE = ORDER_CONFIG.MIN_PRICE_IMPROVEMENT;

export class OrderExecutor {
    private tradingClient: TradingClient;
    private dataStore: DataStore | null;
    private recentlyTradedMarkets: Map<string, Date> = new Map();
    private latencyTracker: LatencyTracker;

    constructor(tradingClient: TradingClient, dataStore?: DataStore) {
        this.tradingClient = tradingClient;
        this.dataStore = dataStore ?? null;
        this.latencyTracker = LatencyTracker.getInstance();
    }

    /**
     * Execute a single opportunity
     */
    async executeOpportunity(opportunity: TradingOpportunity, traceId?: string): Promise<ExecutionResult> {
        if (opportunity.action === 'none') {
            return { opportunity, executed: false, error: 'No action', traceId };
        }

        try {
            const isBuyYes = opportunity.action === 'buy_yes';
            const tokenId = isBuyYes ? opportunity.market.yesTokenId : opportunity.market.noTokenId;
            
            const snapshotPrice = isBuyYes ? opportunity.snapshotYesPrice : opportunity.snapshotNoPrice;
            
            // Get live prices
            let liveYesPrice = opportunity.market.yesPrice;
            let liveNoPrice = opportunity.market.noPrice;
            
            if (this.dataStore) {
                const state = this.dataStore.getMarketState(opportunity.market.market.id);
                if (state) {
                    const lastYes = state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1];
                    const lastNo = state.priceHistory.no.history[state.priceHistory.no.history.length - 1];
                    if (lastYes) liveYesPrice = lastYes.price;
                    if (lastNo) liveNoPrice = lastNo.price;
                }
            }
            
            const livePrice = isBuyYes ? liveYesPrice : liveNoPrice;
            const priceDrift = Math.abs(livePrice - snapshotPrice);

            // Price drift protection
            if (priceDrift > MAX_PRICE_DRIFT) {
                logger.warn(`Price drift too high: ${priceDrift.toFixed(3)} > ${MAX_PRICE_DRIFT}`);
                return { opportunity, executed: false, error: `Price drift: ${priceDrift.toFixed(3)}`, traceId };
            }

            // Recalculate edge with live prices
            // For YES: edge = forecastProb - yesPrice (positive = underpriced YES)
            // For NO: edge = (1 - forecastProb) - noPrice (positive = underpriced NO)
            let liveEdgeForAction = 0;
            let shouldExecute = false;

            if (isBuyYes) {
                liveEdgeForAction = opportunity.forecastProbability - liveYesPrice;
                shouldExecute = liveEdgeForAction > MIN_EXECUTION_EDGE;
            } else {
                liveEdgeForAction = (1 - opportunity.forecastProbability) - liveNoPrice;
                shouldExecute = liveEdgeForAction > MIN_EXECUTION_EDGE;
            }

            if (!shouldExecute) {
                logger.debug(`Edge too small: ${(liveEdgeForAction * 100).toFixed(1)}%`);
                return { opportunity, executed: false, error: 'Edge too small', traceId };
            }

            // Calculate position size
            const positionSize = this.calculatePositionSize(opportunity, liveEdgeForAction, livePrice);
            if (positionSize <= 0) {
                return { opportunity, executed: false, error: 'Position size too small', traceId };
            }

            // Build order
            const priceIncrement = opportunity.isGuaranteed ? ORDER_CONFIG.PRICE_IMPROVEMENT_INCREMENT : ORDER_CONFIG.MIN_PRICE_IMPROVEMENT;
            const order: TradeOrder = {
                tokenId,
                side: 'BUY',
                price: Math.min(livePrice + priceIncrement, 0.99),
                size: positionSize,
                orderType: 'GTC',
            };

            logger.info(`Executing: ${opportunity.market.market.question.substring(0, 40)}... | ${opportunity.action} ${positionSize} @ ${livePrice.toFixed(3)}`);

            // Record order submit time for latency tracking
            if (traceId) {
                this.latencyTracker.recordTime(traceId, 'orderSubmitTime', Date.now());
            }

            // Place order
            const result = await this.tradingClient.placeOrder(order);

            // Record order confirm time and complete trace
            if (traceId) {
                this.latencyTracker.recordTime(traceId, 'orderConfirmTime', Date.now());
                const measurement = this.latencyTracker.completeTrace(traceId);
                if (measurement) {
                    logger.info(`[OrderExecutor] Trace ${traceId} completed`, {
                        totalLatencyMs: measurement.totalLatencyMs,
                        executionLatencyMs: measurement.executionLatencyMs,
                    });
                }
            }

            if (result) {
                this.recentlyTradedMarkets.set(opportunity.market.market.id, new Date());
                return { opportunity, executed: true, orderId: result.orderId, traceId };
            }

            return { opportunity, executed: false, error: 'Order failed', traceId };
        } catch (error) {
            logger.error('Execution error', { error: (error as Error).message });
            return { opportunity, executed: false, error: (error as Error).message, traceId };
        }
    }

    /**
     * Execute multiple opportunities
     */
    async executeOpportunities(opportunities: Array<TradingOpportunity & { traceId?: string }>): Promise<ExecutionResult[]> {
        const results: ExecutionResult[] = [];

        // Filter eligible opportunities
        const eligible = opportunities.filter(opp => {
            if (this.recentlyTraded(opp.market.market.id)) return false;
            
            const isBuyYes = opp.action === 'buy_yes';
            const snapshotPrice = isBuyYes ? opp.snapshotYesPrice : opp.snapshotNoPrice;
            const currentPrice = isBuyYes ? opp.market.yesPrice : opp.market.noPrice;
            const drift = Math.abs(currentPrice - snapshotPrice);
            
            return drift <= MAX_PRICE_DRIFT;
        });

        // Execute all batches in parallel but add cooldown between batch items
        for (let i = 0; i < eligible.length; i += MAX_CONCURRENT_ORDERS) {
            const batch = eligible.slice(i, i + MAX_CONCURRENT_ORDERS);
            const batchResults = await Promise.all(
                batch.map(opp => this.executeOpportunity(opp, opp.traceId))
            );
            results.push(...batchResults);
            
            // FIXED: Add small cooldown between batch items to respect rate limits
            // This ensures we don't overwhelm the order system with concurrent requests
            if (i + MAX_CONCURRENT_ORDERS < eligible.length) {
                await this.delay(100); // 100ms cooldown between batches
            }
        }

        return results;
    }

    /**
     * Calculate position size using proper Kelly Criterion
     * Kelly % = p - q/b where:
     * - p = probability of winning (win rate)
     * - q = probability of losing = 1 - p
     * - b = net payout ratio = (1 - price) / price
     */
    private calculatePositionSize(opportunity: TradingOpportunity, edge: number, price: number): number {
        const maxSize = config.maxPositionSize;
        
        if (price <= 0) return 0;

        // Get win rate from opportunity or use default 50%
        // In a real system, this would be tracked historically
        const winRate = opportunity.confidence || 0.5;
        const lossRate = 1 - winRate;
        
        // Calculate payout ratio (net profit per $1 stake if win)
        // For binary options: if price = 0.60, payout = 0.40/0.60 = 0.67
        const payoutRatio = (1 - price) / price;
        
        // Proper Kelly: f* = p - q/b = p - (1-p)/payoutRatio
        let kelly = winRate - (lossRate / payoutRatio);
        
        // FIXED: Clamp negative Kelly values to 0 (no bet if Kelly is negative)
        kelly = Math.max(0, kelly);
        
        // Apply Kelly multiplier (conservative - use fraction of full Kelly)
        const kellyFraction = kelly * ORDER_CONFIG.KELLY_MULTIPLIER;
        
        // Cap at maximum Kelly fraction (50% is standard Kelly max)
        const MAX_KELLY_FRACTION = 0.5;
        const cappedKelly = Math.min(kellyFraction, MAX_KELLY_FRACTION);
        
        // Calculate position size in USD
        const usdcAmount = maxSize * cappedKelly;

        const shares = Math.floor(usdcAmount / price);
        return Math.max(1, Math.min(shares, Math.floor(maxSize / price)));
    }

    /**
     * Check if recently traded
     */
    private recentlyTraded(marketId: string): boolean {
        const lastTrade = this.recentlyTradedMarkets.get(marketId);
        if (!lastTrade) return false;

        if (Date.now() - lastTrade.getTime() > TRADE_COOLDOWN_MS) {
            this.recentlyTradedMarkets.delete(marketId);
            return false;
        }

        return true;
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default OrderExecutor;
