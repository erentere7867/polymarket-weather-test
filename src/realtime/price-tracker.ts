/**
 * Price Tracker
 * Manages WebSocket subscriptions and updates DataStore with real-time prices
 */

import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { PolymarketWebSocket, PriceUpdate } from '../polymarket/websocket-client.js';

export class PriceTracker {
    private store: DataStore;
    private ws: PolymarketWebSocket;
    private scanner: WeatherScanner | null = null;
    private intervalId: NodeJS.Timeout | null = null;
    // Track already-subscribed tokens to avoid duplicate subscriptions
    private subscribedTokens: Set<string> = new Set();

    constructor(store: DataStore) {
        this.store = store;
        this.ws = new PolymarketWebSocket();
    }

    /**
     * Start tracking prices via WebSocket
     */
    async start(scanner: WeatherScanner, intervalMs: number = 60000): Promise<void> {
        this.scanner = scanner;
        logger.info(`Starting PriceTracker with WebSocket (polling for new markets every ${intervalMs}ms)...`);

        // Connect WS
        this.ws.connect();

        // Handle updates
        this.ws.on('priceUpdate', (update: PriceUpdate) => {
            this.handlePriceUpdate(update);
        });

        // Initial scan and subscribe
        await this.scanAndSubscribe();

        // Periodically scan for NEW markets
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = setInterval(() => this.scanAndSubscribe(), intervalMs);
    }

    /**
     * Stop tracking
     */
    stop(): void {
        logger.info('Stopping PriceTracker...');
        this.ws.disconnect();
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private async scanAndSubscribe() {
        if (!this.scanner) return;
        try {
            const markets = await this.scanner.scanForWeatherMarkets();
            const newTokenIds: string[] = [];
            const now = new Date();

            for (const market of markets) {
                // Register market in store
                this.store.addMarket(market);

                // Update store with initial/polled values (fallback/baseline)
                this.store.updatePrice(market.yesTokenId, market.yesPrice, now);
                this.store.updatePrice(market.noTokenId, market.noPrice, now);
                
                // Only collect NEW tokens that haven't been subscribed yet
                if (!this.subscribedTokens.has(market.yesTokenId)) {
                    newTokenIds.push(market.yesTokenId);
                }
                if (!this.subscribedTokens.has(market.noTokenId)) {
                    newTokenIds.push(market.noTokenId);
                }
            }

            // Subscribe only to NEW tokens (delta-based subscription)
            if (newTokenIds.length > 0) {
                this.ws.subscribeToPrices(newTokenIds);
                // Track newly subscribed tokens
                for (const tokenId of newTokenIds) {
                    this.subscribedTokens.add(tokenId);
                }
                logger.debug(`Subscribed to ${newTokenIds.length} new tokens (total: ${this.subscribedTokens.size})`);
            }

        } catch (error) {
            logger.error('Market scan failed', { error: (error as Error).message });
        }
    }

    private handlePriceUpdate(update: PriceUpdate) {
        const now = new Date();
        
        // Calculate Price: Midpoint of Best Bid and Best Ask if available
        // Note: 'book' events can be snapshots or updates. 
        // We calculate best available price from this payload.

        let bestAsk: number | null = null;
        let bestBid: number | null = null;

        if (update.asks && update.asks.length > 0) {
            const prices = update.asks.map(a => parseFloat(a.price));
            bestAsk = Math.min(...prices);
        }

        if (update.bids && update.bids.length > 0) {
            const prices = update.bids.map(b => parseFloat(b.price));
            bestBid = Math.max(...prices);
        }

        if (bestAsk !== null || bestBid !== null) {
            let price: number;
            
            if (bestAsk !== null && bestBid !== null) {
                price = (bestAsk + bestBid) / 2;
            } else {
                price = bestAsk ?? bestBid ?? 0;
            }

            // Update store
            this.store.updatePrice(update.assetId, price, now);
            // logger.debug(`WS Price Update: ${update.assetId} = ${price.toFixed(3)}`);
        }
    }
}
