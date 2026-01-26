/**
 * Order Executor
 * Converts trading opportunities into orders and manages execution
 */

import { TradingClient } from '../polymarket/clob-client.js';
import { TradingOpportunity, TradeOrder, Position } from '../polymarket/types.js';
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

    // Cache of current positions to prevent re-entering worse trades
    private positions: Map<string, Position> = new Map();

    constructor(tradingClient: TradingClient) {
        this.tradingClient = tradingClient;
    }

    /**
     * Update position cache from external source
     */
    syncPositions(positions: Position[]): void {
        const newPositions = new Map<string, Position>();

        // 1. Load positions from API
        for (const pos of positions) {
            newPositions.set(pos.tokenId, pos);
        }

        // 2. Preserve local positions for recently traded markets (if API is stale)
        for (const [tokenId, cachedPos] of this.positions) {
            // If we have a local position but API doesn't report it yet...
            if (!newPositions.has(tokenId)) {
                // Check if we traded this market recently
                // Note: Position has marketId, recentlyTradedMarkets is keyed by marketId
                const isRecentlyTraded = this.recentlyTradedMarkets.has(cachedPos.marketId);

                if (isRecentlyTraded) {
                    // Keep local version
                    newPositions.set(tokenId, cachedPos);
                    logger.info(`Preserving local position for ${cachedPos.marketQuestion.substring(0, 30)}... (API update pending)`);
                }
            }
        }

        this.positions = newPositions;
        logger.info(`Synced positions: ${positions.length} from API, ${this.positions.size} total cached`);
    }

    /**
     * Execute a trade for an opportunity
     */
    async executeOpportunity(opportunity: TradingOpportunity): Promise<ExecutionResult> {
        if (opportunity.action === 'none') {
            return { opportunity, executed: false, error: 'No action to take' };
        }

        try {
            // Determine token and price
            const isBuyYes = opportunity.action === 'buy_yes';
            const tokenId = isBuyYes ? opportunity.market.yesTokenId : opportunity.market.noTokenId;
            const price = isBuyYes ? opportunity.market.yesPrice : opportunity.market.noPrice;

            // SAFETY CHECK: Compare current price against snapshot price
            // If the market moved significantly between detection and execution, ABORT.
            if (opportunity.snapshotPrice !== undefined) {
                const diff = Math.abs(price - opportunity.snapshotPrice);
                if (diff > 0.05) { // 5 cent tolerance
                    logger.error(`🚨 PRICE SLIPPAGE ABORT: Snapshot ${opportunity.snapshotPrice} -> Current ${price}. Market moved too fast.`);
                    return { opportunity, executed: false, error: 'Price slippage abort' };
                }
            }

            // CHECK: Do we already have a position in this market?
            // If so, avoid "chasing" price significantly higher
            const existingPos = this.positions.get(tokenId);
            if (existingPos && existingPos.size > 1) { // Ignore dust
                // If current price is significantly worse than entry, SKIP
                // "Significantly changed" = > 5 cents or > 10% worse
                const priceDiff = price - existingPos.avgPrice;
                const priceRatio = price / existingPos.avgPrice;

                // Thresholds:
                // 1. Absolute diff > 0.05 (5 cents)
                // 2. Relative diff > 10% (1.10)
                const isSignificantlyWorse = priceDiff > 0.05 || priceRatio > 1.10;

                if (isSignificantlyWorse) {
                    const msg = `Skipping trade: Price chased significantly ($${existingPos.avgPrice.toFixed(2)} -> $${price.toFixed(2)})`;
                    logger.warn(msg, {
                        market: opportunity.market.market.question.substring(0, 40),
                        diff: priceDiff.toFixed(3),
                        ratio: priceRatio.toFixed(2)
                    });
                    return { opportunity, executed: false, error: 'Price chasing prevented' };
                }

                // If not significantly worse, we might add to position, but log it
                logger.info(`Adding to position: Price change acceptable ($${existingPos.avgPrice.toFixed(2)} -> $${price.toFixed(2)})`);
            }

            // Calculate position size
            const positionSize = this.calculatePositionSize(opportunity);

            if (positionSize <= 0) {
                return { opportunity, executed: false, error: 'Position size too small' };
            }

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

            // OPTIMISTIC LOCK: Mark as traded BEFORE placing order to prevent race conditions
            this.recentlyTradedMarkets.set(opportunity.market.market.id, new Date());

            try {
                // Place order
                const result = await this.tradingClient.placeOrder(order);

                if (result) {
                    this.executedOrderIds.add(result.orderId);
                    // Lock is already set above

                    // Optimistically update position cache
                    this.updatePositionCacheOptimistic(order, opportunity);

                    return {
                        opportunity,
                        executed: true,
                        orderId: result.orderId,
                    };
                }

                // If result is null (e.g. error handled internally but didn't throw), remove lock?
                // Depending on implementation, but for safety let's leave it unless we know it failed.
                // If it returned null, it means order wasn't placed.
                this.recentlyTradedMarkets.delete(opportunity.market.market.id);
                return { opportunity, executed: false, error: 'Order placement returned null' };

            } catch (error) {
                // If order placement failed, RELEASE THE LOCK so we can retry later
                this.recentlyTradedMarkets.delete(opportunity.market.market.id);
                throw error; // Re-throw to be caught by outer catch
            }
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
     * Optimistically update position cache after a trade
     */
    private updatePositionCacheOptimistic(order: TradeOrder, opportunity: TradingOpportunity): void {
        const existing = this.positions.get(order.tokenId);

        let newSize = order.size;
        let newAvgPrice = order.price; // Approximation since we don't know fill price exactly yet

        if (existing) {
            const totalCost = (existing.size * existing.avgPrice) + (order.size * order.price);
            newSize = existing.size + order.size;
            newAvgPrice = totalCost / newSize;
        }

        const newPos: Position = {
            tokenId: order.tokenId,
            marketId: opportunity.market.market.id,
            marketQuestion: opportunity.market.market.question,
            side: opportunity.action === 'buy_yes' ? 'yes' : 'no',
            size: newSize,
            avgPrice: newAvgPrice,
            currentPrice: order.price,
            unrealizedPnL: 0, // Not calculated here
            entryTime: new Date(),
        };

        this.positions.set(order.tokenId, newPos);
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
        let maxUsdc = maxSize;

        // Apply multiplier for guaranteed outcomes
        if (opportunity.isGuaranteed) {
            maxUsdc = maxSize * config.guaranteedPositionMultiplier;
            // For guaranteed, we go heavier on Kelly
            // Kelly fraction = edge * confidence. 
            // If guaranteed: edge ~ 0.9, confidence = 1.0 -> kelly = 0.9
            // Max size logic below will cap it.
        }

        const usdcAmount = maxUsdc * Math.min(halfKelly * 10, 1); // Scale and cap at max

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
