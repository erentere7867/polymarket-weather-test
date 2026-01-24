/**
 * Price Tracker
 * Manages WebSocket subscriptions and updates DataStore with real-time prices
 */

import { PolymarketWebSocket } from '../polymarket/websocket-client.js';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherScanner } from '../polymarket/weather-scanner.js';

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

    /**
     * Start polling prices via REST API (Fallback)
     */
    async startPolling(scanner: WeatherScanner, intervalMs: number = 60000): Promise<void> {
        logger.info('Starting PriceTracker polling fallback...');

        const poll = async () => {
            try {
                // logger.debug('Polling prices via REST...');
                const markets = await scanner.scanForWeatherMarkets();
                const now = new Date();

                for (const market of markets) {
                    this.store.updatePrice(market.yesTokenId, market.yesPrice, now);
                    this.store.updatePrice(market.noTokenId, market.noPrice, now);
                }
            } catch (error) {
                logger.error('Price polling failed', { error: (error as Error).message });
            }
        };

        // Initial poll
        await poll();

        // Loop
        setInterval(poll, intervalMs);
    }
}
