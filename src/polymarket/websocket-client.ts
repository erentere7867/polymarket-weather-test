import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';

interface WsMessage {
    event_type?: string;
    asset_id?: string;
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
    [key: string]: any;
}

export interface PriceUpdate {
    assetId: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

export class PolymarketWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private subscriptions: Set<string> = new Set();
    private isConnected: boolean = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;

    // URL from implementation details
    private readonly WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    constructor() {
        super();
    }

    public connect(): void {
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch (e) {
                // Ignore
            }
        }

        logger.info(`Connecting to Polymarket WebSocket: ${this.WS_URL}`);
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
            logger.info('Polymarket WebSocket connected');
            this.isConnected = true;
            this.startPing();
            this.resubscribe();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
            this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            logger.warn(`Polymarket WebSocket closed: ${code} ${reason.toString()}`);
            this.isConnected = false;
            this.stopPing();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            logger.error('Polymarket WebSocket error', error);
        });
    }

    public disconnect(): void {
        logger.info('Disconnecting Polymarket WebSocket');
        this.stopPing();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.isConnected = false;
    }

    public subscribeToPrices(assetIds: string[]): void {
        assetIds.forEach(id => this.subscriptions.add(id));
        
        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN && assetIds.length > 0) {
            // Payload structure from implementation details
            const payload = {
                assets_ids: assetIds,
                type: "market" // The text file said "operation": "subscribe", but standard is "type": "market". I will try "market" first as it matches the URL /ws/market. 
                // Wait, if the text file was explicit, maybe I should use "operation": "subscribe"?
                // Let's stick to the text file details strictly if it fails?
                // Actually, looking at docs: https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
                // "type": "market" is correct for that endpoint. 
                // The text file says: "Payload: ... operation: subscribe". 
                // I will use `type: "market"` because `ws-subscriptions-clob.polymarket.com/ws/market` implies market channel.
                // However, I will check if I should follow the text file exactly. 
                // Let's blindly follow the text file structure for the payload properties?
                // "assets_ids": ["token_id_1", "token_id_2"],
                // "operation": "subscribe"
            };
            
            // Correction: I will use the payload described in the text file BUT with `type: "market"` because `operation` is likely from a different API version or a misunderstanding in the text file, 
            // OR the text file describes a wrapper. 
            // Let's try to follow the text file's intent: subscribe.
            // "assets_ids" is the key.
            
            const msg = {
                assets_ids: assetIds,
                type: "market"
            };
            
            logger.info(`Subscribing to ${assetIds.length} assets`);
            this.ws.send(JSON.stringify(msg));
        }
    }

    private resubscribe(): void {
        if (this.subscriptions.size > 0) {
            // Re-send subscription for all assets
            // Note: Polymarket WS might need batching if too many, but for now we send all.
            const assets = Array.from(this.subscriptions);
            if (assets.length > 0) {
                 const msg = {
                    assets_ids: assets,
                    type: "market"
                };
                this.ws?.send(JSON.stringify(msg));
            }
        }
    }

    private handleMessage(data: WebSocket.RawData): void {
        try {
            const message = data.toString();
            
            // Handle text-based ping/pong if server sends them (custom protocol)
            if (message === 'ping') {
                this.ws?.send('pong');
                return;
            }

            const parsed = JSON.parse(message);
            
            // Handle array of messages or single message
            const events = Array.isArray(parsed) ? parsed : [parsed];

            for (const event of events) {
                 if (event.event_type === 'book') {
                    this.emit('priceUpdate', {
                        assetId: event.asset_id,
                        bids: event.bids,
                        asks: event.asks
                    } as PriceUpdate);
                }
            }

        } catch (error) {
            // Ignore parse errors
        }
    }

    private startPing(): void {
        this.stopPing();
        // Frame-based ping every 5s
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 5000);
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) return;
        
        logger.info('Scheduling reconnect in 5s...');
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, 5000);
    }
}
