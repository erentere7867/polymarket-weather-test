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
                if (event.event_type === 'price_change' || event.event_type === 'book') {
                    // event.asset_id is the token ID
                    // event.price is the price (for price_change)
                    // For book, we might need to parse bids/asks, but CLOB WS usually sends price updates or orderbook updates

                    // Note: Polymarket CLOB WS 'market' channel sends orderbook updates
                    // Format: { "event_type": "book", "asset_id": "...", "bids": [...], "asks": [...] }
                    // OR { "event_type": "price_change", ... } ?

                    // Actually, let's handle "book" updates which contain the best bid/ask
                    if (event.event_type === 'book' || event.eventType === 'book') {
                        const tokenId = event.asset_id;
                        // Calculate mid price or best bid/ask
                        // simplified: just log for now to see format, or try to extract price

                        // If we receive book updates, we can derive price. Needs parsing.
                        // Let's assume we get updates. Current store expects a single price.
                        // Let's use the 'price' field if available, or midpoint of best bid/ask

                        let price: number | null = null;

                        if (event.bids && event.bids.length > 0 && event.asks && event.asks.length > 0) {
                            const bestBid = parseFloat(event.bids[0].price);
                            const bestAsk = parseFloat(event.asks[0].price);
                            price = (bestBid + bestAsk) / 2;
                        }

                        if (price !== null && tokenId) {
                            this.store.updatePrice(tokenId, price, new Date());
                        }
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
