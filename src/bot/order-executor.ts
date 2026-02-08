/**
 * Order Executor
 * Executes trading opportunities with live price validation
 */

import { TradingClient } from '../polymarket/clob-client.js';
import { TradingOpportunity, TradeOrder } from '../polymarket/types.js';
import { DataStore } from '../realtime/data-store.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface ExecutionResult {
    opportunity: TradingOpportunity;
    executed: boolean;
    orderId?: string;
    error?: string;
}

const TRADE_COOLDOWN_MS = 30000;
const MAX_CONCURRENT_ORDERS = 5;
const MAX_PRICE_DRIFT = 0.15;
const MIN_EXECUTION_EDGE = 0.02;

export class OrderExecutor {
    private tradingClient: TradingClient;
    private dataStore: DataStore | null;
    private recentlyTradedMarkets: Map<string, Date> = new Map();

    constructor(tradingClient: TradingClient, dataStore?: DataStore) {
        this.tradingClient = tradingClient;
        this.dataStore = dataStore ?? null;
    }

    /**
     * Execute a single opportunity
     */
    async executeOpportunity(opportunity: TradingOpportunity): Promise<ExecutionResult> {
        if (opportunity.action === 'none') {
            return { opportunity, executed: false, error: 'No action' };
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
                return { opportunity, executed: false, error: `Price drift: ${priceDrift.toFixed(3)}` };
            }

            // Recalculate edge with live prices
            const liveMarketProbability = liveYesPrice;
            const liveEdge = opportunity.forecastProbability - liveMarketProbability;
            const absLiveEdge = Math.abs(liveEdge);

            let shouldExecute = false;
            let liveEdgeForAction = 0;

            if (isBuyYes) {
                liveEdgeForAction = liveEdge;
                shouldExecute = liveEdge > MIN_EXECUTION_EDGE;
            } else {
                liveEdgeForAction = -liveEdge;
                shouldExecute = liveEdgeForAction > MIN_EXECUTION_EDGE;
            }

            if (!shouldExecute) {
                logger.debug(`Edge too small: ${(liveEdgeForAction * 100).toFixed(1)}%`);
                return { opportunity, executed: false, error: 'Edge too small' };
            }

            // Calculate position size
            const positionSize = this.calculatePositionSize(opportunity, liveEdgeForAction, livePrice);
            if (positionSize <= 0) {
                return { opportunity, executed: false, error: 'Position size too small' };
            }

            // Build order
            const priceIncrement = opportunity.isGuaranteed ? 0.05 : 0.01;
            const order: TradeOrder = {
                tokenId,
                side: 'BUY',
                price: Math.min(livePrice + priceIncrement, 0.99),
                size: positionSize,
                orderType: 'GTC',
            };

            logger.info(`Executing: ${opportunity.market.market.question.substring(0, 40)}... | ${opportunity.action} ${positionSize} @ ${livePrice.toFixed(3)}`);

            // Place order
            const result = await this.tradingClient.placeOrder(order);

            if (result) {
                this.recentlyTradedMarkets.set(opportunity.market.market.id, new Date());
                return { opportunity, executed: true, orderId: result.orderId };
            }

            return { opportunity, executed: false, error: 'Order failed' };
        } catch (error) {
            logger.error('Execution error', { error: (error as Error).message });
            return { opportunity, executed: false, error: (error as Error).message };
        }
    }

    /**
     * Execute multiple opportunities
     */
    async executeOpportunities(opportunities: TradingOpportunity[]): Promise<ExecutionResult[]> {
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

        // Execute in batches
        for (let i = 0; i < eligible.length; i += MAX_CONCURRENT_ORDERS) {
            const batch = eligible.slice(i, i + MAX_CONCURRENT_ORDERS);
            const batchResults = await Promise.all(
                batch.map(opp => this.executeOpportunity(opp))
            );
            results.push(...batchResults);
            
            if (i + MAX_CONCURRENT_ORDERS < eligible.length) {
                await this.delay(50);
            }
        }

        return results;
    }

    /**
     * Calculate position size
     */
    private calculatePositionSize(opportunity: TradingOpportunity, edge: number, price: number): number {
        const maxSize = config.maxPositionSize;
        const kellyFraction = Math.abs(edge) * opportunity.confidence;
        const halfKelly = kellyFraction * 0.5;
        const usdcAmount = maxSize * Math.min(halfKelly * 10, 1);

        if (price <= 0) return 0;

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
