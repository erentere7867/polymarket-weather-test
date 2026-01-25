/**
 * Order Executor
 * Converts trading opportunities into orders and manages execution
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
const TRADE_COOLDOWN_MS = 60000; // 60 seconds

export class OrderExecutor {
    private tradingClient: TradingClient;
    private executedOrderIds: Set<string> = new Set();
    private recentlyTradedMarkets: Map<string, Date> = new Map();

    constructor(tradingClient: TradingClient) {
        this.tradingClient = tradingClient;
    }

    /**
     * Execute a trade for an opportunity
     */
    async executeOpportunity(opportunity: TradingOpportunity): Promise<ExecutionResult> {
        if (opportunity.action === 'none') {
            return { opportunity, executed: false, error: 'No action to take' };
        }

        try {
            // Calculate position size
            const positionSize = this.calculatePositionSize(opportunity);

            if (positionSize <= 0) {
                return { opportunity, executed: false, error: 'Position size too small' };
            }

            // Determine token and price
            const isBuyYes = opportunity.action === 'buy_yes';
            const tokenId = isBuyYes ? opportunity.market.yesTokenId : opportunity.market.noTokenId;
            const price = isBuyYes ? opportunity.market.yesPrice : opportunity.market.noPrice;

            // For guaranteed outcomes, use more aggressive pricing to ensure fills
            const isGuaranteed = opportunity.isGuaranteed || false;
            const priceIncrement = isGuaranteed ? 0.05 : 0.01; // 5¢ for guaranteed, 1¢ otherwise

            // Build order
            const order: TradeOrder = {
                tokenId,
                side: 'BUY',
                price: Math.min(price + priceIncrement, 0.99),
                size: positionSize,
                orderType: 'GTC', // Good til cancelled
            };

            logger.info('Executing trade', {
                market: opportunity.market.market.question.substring(0, 50),
                action: opportunity.action,
                edge: (opportunity.edge * 100).toFixed(2) + '%',
                price: order.price,
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
     */
    private calculatePositionSize(opportunity: TradingOpportunity): number {
        const maxSize = config.maxPositionSize;
        const edge = Math.abs(opportunity.edge);
        const confidence = opportunity.confidence;

        // Kelly fraction = (bp - q) / b
        // Simplified: edge * confidence
        const kellyFraction = edge * confidence;

        // Use half Kelly for safety
        const halfKelly = kellyFraction * 0.5;

        // Calculate USDC amount
        const usdcAmount = maxSize * Math.min(halfKelly * 10, 1); // Scale and cap at max

        // Calculate number of shares (price determines how many shares per USDC)
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

        for (const opportunity of opportunities) {
            // Skip if we've already traded this market recently
            const marketKey = opportunity.market.market.id;
            if (this.recentlyTraded(marketKey)) {
                logger.debug(`Skipping recently traded market: ${opportunity.market.market.question.substring(0, 40)}`);
                continue;
            }

            const result = await this.executeOpportunity(opportunity);
            results.push(result);

            // Rate limit: wait between orders
            if (results.length < opportunities.length) {
                await this.delay(1000);
            }
        }

        return results;
    }

    /**
     * Check if a market was recently traded (to avoid duplicate trades)
     */
    private recentlyTraded(marketKey: string): boolean {
        const lastTrade = this.recentlyTradedMarkets.get(marketKey);
        if (!lastTrade) return false;

        const elapsed = Date.now() - lastTrade.getTime();
        if (elapsed > TRADE_COOLDOWN_MS) {
            // Cooldown expired, clean up and allow trading
            this.recentlyTradedMarkets.delete(marketKey);
            return false;
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
