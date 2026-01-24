/**
 * Price Tracker
 * Manages WebSocket subscriptions and updates DataStore with real-time prices
 */

import { PolymarketWebSocket } from '../polymarket/websocket-client.js';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';

export class PriceTracker {
    private ws: PolymarketWebSocket;
    private store: DataStore;

    constructor(store: DataStore) {
        this.store = store;
        this.ws = new PolymarketWebSocket();
    }

    /**
     * Connect to WebSocket
     */
    async connect(): Promise<void> {
        await this.ws.connect();
        logger.info('PriceTracker connected to WebSocket');
    }

    /**
     * Track a market (subscribe to prices)
     */
    trackMarket(marketId: string): void {
        const state = this.store.getMarketState(marketId);
        if (!state) return;

        // Subscribe to YES token
        this.ws.subscribeToPrice(state.market.yesTokenId, (update) => {
            this.store.updatePrice(update.tokenId, update.price, update.timestamp);
            // logger.debug(`Price update: ${state.market.eventTitle} YES = ${update.price}`);
        });

        // Subscribe to NO token
        this.ws.subscribeToPrice(state.market.noTokenId, (update) => {
            this.store.updatePrice(update.tokenId, update.price, update.timestamp);
            // logger.debug(`Price update: ${state.market.eventTitle} NO = ${update.price}`);
        });
    }

    /**
     * Stop tracking a market
     */
    untrackMarket(marketId: string): void {
        const state = this.store.getMarketState(marketId);
        if (!state) return;

        this.ws.unsubscribe(state.market.yesTokenId);
        this.ws.unsubscribe(state.market.noTokenId);
    }

    /**
     * Disconnect
     */
    disconnect(): void {
        this.ws.disconnect();
    }
}
