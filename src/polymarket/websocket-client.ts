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

interface QueuedMessage {
    message: string;
    timestamp: number;
}

export class PolymarketWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private pongTimeout: NodeJS.Timeout | null = null;
    private subscriptions: Set<string> = new Set();
    private isConnectedFlag: boolean = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private messageQueue: QueuedMessage[] = [];
    private lastPongReceived: number = 0;
    private reconnectAttempts: number = 0;

    // URL from implementation details
    private readonly WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    // Configuration constants
    private readonly PING_INTERVAL_MS = 5000;
    private readonly PONG_TIMEOUT_MS = 10000; // 2x ping interval
    private readonly MAX_RECONNECT_DELAY_MS = 30000;
    private readonly INITIAL_RECONNECT_DELAY_MS = 1000;
    private readonly MESSAGE_QUEUE_MAX_SIZE = 100;

    constructor() {
        super();
    }

    /**
     * Check if the WebSocket is connected and ready for communication
     */
    public isConnected(): boolean {
        return this.isConnectedFlag && 
               this.ws !== null && 
               this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Get the current number of queued messages waiting to be sent
     */
    public getQueuedMessageCount(): number {
        return this.messageQueue.length;
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
            this.isConnectedFlag = true;
            this.reconnectAttempts = 0; // Reset backoff on successful connection
            this.lastPongReceived = Date.now();
            this.startPing();
            this.startPongMonitor();
            this.resubscribe();
            this.flushMessageQueue();
        });
        
        this.ws.on('message', (data: WebSocket.RawData) => {
            this.handleMessage(data);
        });
        
        this.ws.on('pong', () => {
            this.lastPongReceived = Date.now();
            logger.debug('Received pong from server');
        });
        
        this.ws.on('ping', () => {
            // Respond to server-initiated pings immediately
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.pong();
                logger.debug('Responded to server ping with pong');
            }
        });
        
        this.ws.on('close', (code, reason) => {
            logger.warn(`Polymarket WebSocket closed: ${code} ${reason.toString()}`);
            this.handleDisconnect();
        });
        
        this.ws.on('error', (error) => {
            logger.error('Polymarket WebSocket error', error);
        });
    }

    public disconnect(): void {
        logger.info('Disconnecting Polymarket WebSocket');
        this.stopPing();
        this.stopPongMonitor();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.isConnectedFlag = false;
        this.reconnectAttempts = 0;
        this.messageQueue = [];
    }

    public subscribeToPrices(assetIds: string[]): void {
        assetIds.forEach(id => this.subscriptions.add(id));
        
        if (assetIds.length === 0) {
            return;
        }

        const msg = {
            assets_ids: assetIds,
            type: "market"
        };

        const messageStr = JSON.stringify(msg);

        if (this.isConnected()) {
            logger.info(`Subscribing to ${assetIds.length} assets`);
            this.sendMessage(messageStr);
        } else {
            logger.warn(`WebSocket not connected, queuing subscription for ${assetIds.length} assets`);
            this.queueMessage(messageStr);
        }
    }

    /**
     * Send a message with connection state validation
     * Returns true if sent immediately, false if queued or failed
     */
    private sendMessage(message: string): boolean {
        if (!this.isConnected()) {
            logger.warn('Cannot send message: WebSocket not connected');
            this.queueMessage(message);
            return false;
        }

        try {
            this.ws!.send(message);
            return true;
        } catch (error) {
            logger.error('Failed to send WebSocket message', error);
            this.queueMessage(message);
            return false;
        }
    }

    /**
     * Queue a message to be sent when connection is restored
     */
    private queueMessage(message: string): void {
        if (this.messageQueue.length >= this.MESSAGE_QUEUE_MAX_SIZE) {
            logger.warn(`Message queue full (${this.MESSAGE_QUEUE_MAX_SIZE}), dropping oldest message`);
            this.messageQueue.shift();
        }
        this.messageQueue.push({
            message,
            timestamp: Date.now()
        });
        logger.debug(`Message queued. Queue size: ${this.messageQueue.length}`);
    }

    /**
     * Flush all queued messages when connection is restored
     */
    private flushMessageQueue(): void {
        if (this.messageQueue.length === 0) {
            return;
        }

        logger.info(`Flushing ${this.messageQueue.length} queued messages`);
        
        // Process queue in order
        while (this.messageQueue.length > 0) {
            const queued = this.messageQueue.shift();
            if (queued && this.isConnected()) {
                try {
                    this.ws!.send(queued.message);
                } catch (error) {
                    logger.error('Failed to send queued message', error);
                    // Re-queue if still connected, otherwise will be handled by reconnect
                    if (this.isConnected()) {
                        this.messageQueue.unshift(queued);
                        break;
                    }
                }
            }
        }
    }

    private resubscribe(): void {
        if (this.subscriptions.size > 0) {
            const assets = Array.from(this.subscriptions);
            const msg = {
                assets_ids: assets,
                type: "market"
            };
            this.sendMessage(JSON.stringify(msg));
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

    private handleDisconnect(): void {
        this.isConnectedFlag = false;
        this.stopPing();
        this.stopPongMonitor();
        this.scheduleReconnect();
    }

    private startPing(): void {
        this.stopPing();
        // Frame-based ping every 5s
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
                logger.debug('Sent ping to server');
            }
        }, this.PING_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Start monitoring for pong responses to detect zombie connections
     */
    private startPongMonitor(): void {
        this.stopPongMonitor();
        this.pongTimeout = setInterval(() => {
            const timeSinceLastPong = Date.now() - this.lastPongReceived;
            
            if (timeSinceLastPong > this.PONG_TIMEOUT_MS) {
                logger.warn(`No pong received for ${timeSinceLastPong}ms, connection may be dead. Forcing reconnect...`);
                this.forceReconnect();
            }
        }, this.PING_INTERVAL_MS);
    }

    private stopPongMonitor(): void {
        if (this.pongTimeout) {
            clearInterval(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    /**
     * Force a reconnection by terminating the current connection
     */
    private forceReconnect(): void {
        logger.warn('Forcing WebSocket reconnection due to heartbeat timeout');
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch (e) {
                // Ignore
            }
            this.ws = null;
        }
        this.handleDisconnect();
    }

    /**
     * Calculate reconnect delay with exponential backoff
     */
    private getReconnectDelay(): number {
        const delay = Math.min(
            this.INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            this.MAX_RECONNECT_DELAY_MS
        );
        return delay;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) return;
        
        this.reconnectAttempts++;
        const delay = this.getReconnectDelay();
        
        logger.info(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, delay);
    }
}
