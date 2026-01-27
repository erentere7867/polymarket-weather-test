/**
 * Price Tracker
 * Manages WebSocket subscriptions and updates DataStore with real-time prices
 */

import WebSocket from 'ws';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { config } from '../config.js';

export class PriceTracker {
    private store: DataStore;
    private ws: WebSocket | null = null;
    private trackedTokenIds: Set<string> = new Set();
    private scanner: WeatherScanner | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private scanInterval: NodeJS.Timeout | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private isSimulator: boolean = false;

    constructor(store: DataStore) {
        this.store = store;
        this.isSimulator = config.simulationMode;
    }

    /**
     * Start tracking prices via WebSocket + Periodic Discovery
     */
    async start(scanner: WeatherScanner): Promise<void> {
        this.scanner = scanner;
        logger.info('Starting PriceTracker (WebSocket Mode)...');

        // 1. Initial Scan
        await this.scanAndSubscribe();

        // 2. Connect WebSocket
        this.connect();

        // 3. Schedule Periodic Scan (every 10 minutes)
        // To discover NEW markets that appear
        this.scanInterval = setInterval(() => this.scanAndSubscribe(), 10 * 60 * 1000);
    }

    private connect(): void {
        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
        logger.info(`Connecting to WebSocket: ${wsUrl}`);

        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            logger.info('✅ WebSocket connected');
            this.subscribeToAll();
            this.startPing();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            const raw = data.toString();
            try {
                if (raw === 'PONG') return; // Ignore pong responses

                const message = JSON.parse(raw);
                this.handleMessage(message);
            } catch (error) {
                logger.error('Failed to parse WebSocket message', {
                    error: (error as Error).message,
                    raw: raw.substring(0, 100) // Log first 100 chars
                });
            }
        });

        this.ws.on('close', () => {
            logger.warn('WebSocket disconnected. Reconnecting in 5s...');
            this.stopPing();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            logger.error('WebSocket error', { error: error.message });
            this.ws?.close();
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    }

    private startPing(): void {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, 30000); // Ping every 30s
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Handle incoming price updates
     * Message format: [{"event_type": "price_change", "asset_id": "...", "price": "..."}]
     * Or array of these
     */
    private handleMessage(message: any): void {
        if (Array.isArray(message)) {
            for (const event of message) {
                // Handle "price_change" events (Last Trade Price)
                if (event.event_type === 'price_change') {
                    const tokenId = event.asset_id;
                    const price = parseFloat(event.price);

                    if (tokenId && !isNaN(price)) {
                        this.store.updatePrice(tokenId, price, new Date());
                    }
                }

                // Handle "book" events (Order Book Updates)
                else if (event.event_type === 'book') {
                    const tokenId = event.asset_id;

                    // If we receive book updates, we can derive price. Needs parsing.
                    // Let's use the midpoint of best bid/ask

                    let price: number | null = null;
                    const bids = event.bids || [];
                    const asks = event.asks || [];

                    if (bids.length > 0 && asks.length > 0) {
                        // Find Best Bid (Highest Price)
                        // Bids are sorted ascending (worst to best), but we iterate to be safe
                        let bestBid = parseFloat(bids[0].price);
                        for (let i = 1; i < bids.length; i++) {
                            const p = parseFloat(bids[i].price);
                            if (p > bestBid) bestBid = p;
                        }

                        // Find Best Ask (Lowest Price)
                        // Asks are sorted descending (worst to best), but we iterate to be safe
                        let bestAsk = parseFloat(asks[0].price);
                        for (let i = 1; i < asks.length; i++) {
                            const p = parseFloat(asks[i].price);
                            if (p < bestAsk) bestAsk = p;
                        }

                        price = (bestBid + bestAsk) / 2;
                    }

                    if (price !== null && tokenId) {
                        this.store.updatePrice(tokenId, price, new Date());
                    }
                }
            }
        }
    }

    /**
     * Scan for markets and subscribe to them
     */
    private async scanAndSubscribe(): Promise<void> {
        if (!this.scanner) return;

        logger.info('Scanning for weather markets...');
        try {
            const markets = await this.scanner.scanForWeatherMarkets();
            const now = new Date();

            let newTokens = 0;
            const currentTokenIds = new Set<string>();

            for (const market of markets) {
                // Update store with initial/REST prices
                this.store.addMarket(market); // Ensure market is in store
                this.store.updatePrice(market.yesTokenId, market.yesPrice, now);
                this.store.updatePrice(market.noTokenId, market.noPrice, now);

                currentTokenIds.add(market.yesTokenId);
                currentTokenIds.add(market.noTokenId);

                if (!this.trackedTokenIds.has(market.yesTokenId)) newTokens++;
            }

            // Update tracked tokens
            this.trackedTokenIds = currentTokenIds;

            if (newTokens > 0) {
                logger.info(`Found ${newTokens} new tokens. Updating subscriptions...`);
                this.subscribeToAll();
            }
        } catch (error) {
            logger.error('Market scan failed', { error: (error as Error).message });
        }
    }

    private subscribeToAll(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.trackedTokenIds.size === 0) return;

        const assetIds = Array.from(this.trackedTokenIds);

        // Subscribe in batches if needed (Polymarket might have limits)
        // But for now, send all
        const payload = {
            assets_ids: assetIds,
            type: "market"
        };

        this.ws.send(JSON.stringify(payload));
        logger.info(`Subscribed to ${assetIds.length} tokens`);
    }

    stop(): void {
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.ws?.close();
    }
}
