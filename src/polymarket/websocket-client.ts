/**
 * Polymarket WebSocket Client
 * Real-time price updates for markets
 */

import WebSocket from 'ws';
import { logger } from '../logger.js';

interface PriceUpdate {
    tokenId: string;
    price: number;
    timestamp: Date;
}

interface OrderBookUpdate {
    market: string;
    assetId: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
    timestamp: string;
}

type PriceCallback = (update: PriceUpdate) => void;
type OrderBookCallback = (update: OrderBookUpdate) => void;

export class PolymarketWebSocket {
    private ws: WebSocket | null = null;
    private readonly wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    private subscribedTokens: Set<string> = new Set();
    private priceCallbacks: Map<string, PriceCallback[]> = new Map();
    private orderBookCallbacks: Map<string, OrderBookCallback[]> = new Map();
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectDelay: number = 5000;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private isConnected: boolean = false;

    constructor() { }

    /**
     * Connect to WebSocket
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.wsUrl);

                this.ws.on('open', () => {
                    logger.info('WebSocket connected to Polymarket');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();

                    // Resubscribe to previously subscribed tokens
                    for (const tokenId of this.subscribedTokens) {
                        this.sendSubscription(tokenId);
                    }

                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data);
                });

                this.ws.on('error', (error) => {
                    logger.error('WebSocket error', { error: error.message });
                    if (!this.isConnected) {
                        reject(error);
                    }
                });

                this.ws.on('close', () => {
                    logger.warn('WebSocket disconnected');
                    this.isConnected = false;
                    this.stopHeartbeat();
                    this.attemptReconnect();
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Subscribe to price updates for a token
     */
    subscribeToPrice(tokenId: string, callback: PriceCallback): void {
        this.subscribedTokens.add(tokenId);

        if (!this.priceCallbacks.has(tokenId)) {
            this.priceCallbacks.set(tokenId, []);
        }
        this.priceCallbacks.get(tokenId)!.push(callback);

        if (this.isConnected) {
            this.sendSubscription(tokenId);
        }
    }

    /**
     * Subscribe to order book updates
     */
    subscribeToOrderBook(tokenId: string, callback: OrderBookCallback): void {
        this.subscribedTokens.add(tokenId);

        if (!this.orderBookCallbacks.has(tokenId)) {
            this.orderBookCallbacks.set(tokenId, []);
        }
        this.orderBookCallbacks.get(tokenId)!.push(callback);

        if (this.isConnected) {
            this.sendSubscription(tokenId);
        }
    }

    /**
     * Unsubscribe from a token
     */
    unsubscribe(tokenId: string): void {
        this.subscribedTokens.delete(tokenId);
        this.priceCallbacks.delete(tokenId);
        this.orderBookCallbacks.delete(tokenId);

        if (this.isConnected && this.ws) {
            this.ws.send(JSON.stringify({
                type: 'unsubscribe',
                channel: 'market',
                assets_ids: [tokenId],
            }));
        }
    }

    /**
     * Send subscription message
     */
    private sendSubscription(tokenId: string): void {
        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                channel: 'market',
                assets_ids: [tokenId],
            }));
            logger.debug(`Subscribed to token: ${tokenId.substring(0, 20)}...`);
        }
    }

    /**
     * Handle incoming WebSocket message
     */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const message = JSON.parse(data.toString());

            if (message.type === 'price_change') {
                const update: PriceUpdate = {
                    tokenId: message.asset_id,
                    price: parseFloat(message.price),
                    timestamp: new Date(),
                };

                const callbacks = this.priceCallbacks.get(message.asset_id);
                if (callbacks) {
                    callbacks.forEach(cb => cb(update));
                }
            }

            if (message.type === 'book') {
                const update: OrderBookUpdate = {
                    market: message.market,
                    assetId: message.asset_id,
                    bids: message.bids || [],
                    asks: message.asks || [],
                    timestamp: message.timestamp,
                };

                const callbacks = this.orderBookCallbacks.get(message.asset_id);
                if (callbacks) {
                    callbacks.forEach(cb => cb(update));
                }
            }

        } catch (error) {
            logger.error('Failed to parse WebSocket message', { error: (error as Error).message });
        }
    }

    /**
     * Start heartbeat to keep connection alive
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.isConnected) {
                this.ws.ping();
            }
        }, 30000);
    }

    /**
     * Stop heartbeat
     */
    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Attempt to reconnect
     */
    private async attemptReconnect(): Promise<void> {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        logger.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));

        try {
            await this.connect();
        } catch (error) {
            logger.error('Reconnection failed', { error: (error as Error).message });
        }
    }

    /**
     * Disconnect WebSocket
     */
    disconnect(): void {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.subscribedTokens.clear();
        this.priceCallbacks.clear();
        this.orderBookCallbacks.clear();
    }

    /**
     * Check if connected
     */
    isWebSocketConnected(): boolean {
        return this.isConnected;
    }
}
