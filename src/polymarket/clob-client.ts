/**
 * Polymarket CLOB Trading Client
 * Handles order placement and management
 */

import { ClobClient, Side, OrderType, ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet, providers } from 'ethers';
import axios, { AxiosInstance } from 'axios';
import { config, hasApiCredentials, getApiCredentials } from '../config.js';
import { logger } from '../logger.js';
import { TradeOrder, OrderBook, Position } from './types.js';

interface MarketInfo {
    tickSize: TickSize;
    negRisk: boolean;
}

export class TradingClient {
    private client: ClobClient | null = null;
    private httpClient: AxiosInstance;
    private dataApiClient: AxiosInstance;
    private initialized: boolean = false;
    private apiCreds: ApiKeyCreds | null = null;

    constructor() {
        this.httpClient = axios.create({
            baseURL: config.clobHost,
            timeout: 15000,
        });
        this.dataApiClient = axios.create({
            baseURL: config.dataApiHost,
            timeout: 15000,
        });
    }

    /**
     * Initialize the trading client with wallet credentials
     */
    async initialize(): Promise<void> {
        if (config.simulationMode) {
            logger.info('Running in SIMULATION mode - no real trades will be placed');
            this.initialized = true;
            return;
        }

        if (!config.privateKey) {
            throw new Error('POLYMARKET_PRIVATE_KEY required for live trading');
        }

        try {
            // Create provider and signer
            const provider = new providers.JsonRpcProvider(config.polygonRpcUrl);
            const signer = new Wallet(config.privateKey, provider);

            // Check if we have pre-configured API credentials
            if (hasApiCredentials()) {
                const creds = getApiCredentials()!;
                this.apiCreds = {
                    key: creds.apiKey,
                    secret: creds.secret,
                    passphrase: creds.passphrase,
                };
                logger.info('Using pre-configured Polymarket API credentials');
            } else {
                // Initialize client for API key derivation
                this.client = new ClobClient(config.clobHost, config.chainId, signer);

                // Derive or create API credentials
                this.apiCreds = await this.client.createOrDeriveApiKey();
                logger.info('Derived Polymarket API credentials');
                logger.info('Save these credentials to your .env file:');
                logger.info(`POLYMARKET_API_KEY=${this.apiCreds.key}`);
                logger.info(`POLYMARKET_SECRET=${this.apiCreds.secret}`);
                logger.info(`POLYMARKET_PASSPHRASE=${this.apiCreds.passphrase}`);
            }

            // Initialize with full authentication
            const signatureType = 0; // EOA
            const funderAddress = signer.address;

            this.client = new ClobClient(
                config.clobHost,
                config.chainId,
                signer,
                this.apiCreds,
                signatureType,
                funderAddress
            );

            this.initialized = true;
            logger.info(`Trading client initialized for wallet: ${signer.address}`);
        } catch (error) {
            logger.error('Failed to initialize trading client', { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get current price for a token
     */
    async getPrice(tokenId: string, side: 'buy' | 'sell'): Promise<number> {
        try {
            const response = await this.httpClient.get('/price', {
                params: {
                    token_id: tokenId,
                    side,
                },
            });
            return parseFloat(response.data.price);
        } catch (error) {
            logger.error('Failed to get price', { tokenId, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get order book for a token
     */
    async getOrderBook(tokenId: string): Promise<OrderBook> {
        try {
            const response = await this.httpClient.get('/book', {
                params: { token_id: tokenId },
            });
            return response.data;
        } catch (error) {
            logger.error('Failed to get order book', { tokenId, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get best ask price for a token from the order book
     * Returns null if no asks available
     */
    async getBestAsk(tokenId: string): Promise<number | null> {
        try {
            const book = await this.getOrderBook(tokenId);
            if (!book.asks || book.asks.length === 0) {
                return null;
            }
            // Asks are sorted ascending (lowest first)
            return parseFloat(book.asks[0].price);
        } catch (error) {
            logger.warn('Failed to get best ask', { tokenId, error: (error as Error).message });
            return null;
        }
    }

    /**
     * Get market info (needed for order placement)
     */
    async getMarketInfo(tokenId: string): Promise<MarketInfo> {
        try {
            const response = await this.httpClient.get(`/markets/${tokenId}`);
            return {
                tickSize: response.data.minimum_tick_size || '0.01',
                negRisk: response.data.neg_risk || false,
            };
        } catch (error) {
            // Default values if can't fetch
            logger.warn('Could not fetch market info, using defaults', { tokenId });
            return { tickSize: '0.01', negRisk: false };
        }
    }

    /**
     * Place an order on Polymarket
     */
    async placeOrder(order: TradeOrder): Promise<{ orderId: string; status: string } | null> {
        if (config.simulationMode) {
            logger.info('SIMULATION: Would place order', {
                tokenId: order.tokenId,
                side: order.side,
                price: order.price,
                size: order.size,
            });
            return { orderId: 'SIM_' + Date.now(), status: 'SIMULATED' };
        }

        if (!this.client || !this.initialized) {
            throw new Error('Trading client not initialized');
        }

        try {
            const marketInfo = await this.getMarketInfo(order.tokenId);

            const response = await this.client.createAndPostOrder(
                {
                    tokenID: order.tokenId,
                    price: order.price,
                    size: order.size,
                    side: order.side === 'BUY' ? Side.BUY : Side.SELL,
                },
                {
                    tickSize: marketInfo.tickSize,
                    negRisk: marketInfo.negRisk,
                },
                OrderType.GTC
            );

            logger.info('Order placed successfully', {
                orderId: response.orderID,
                status: response.status,
            });

            return {
                orderId: response.orderID,
                status: response.status,
            };
        } catch (error) {
            logger.error('Failed to place order', { order, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get open orders
     */
    async getOpenOrders(): Promise<any[]> {
        if (config.simulationMode) {
            return [];
        }

        if (!this.client) {
            throw new Error('Trading client not initialized');
        }

        try {
            return await this.client.getOpenOrders();
        } catch (error) {
            logger.error('Failed to get open orders', { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId: string): Promise<void> {
        if (config.simulationMode) {
            logger.info('SIMULATION: Would cancel order', { orderId });
            return;
        }

        if (!this.client) {
            throw new Error('Trading client not initialized');
        }

        try {
            await this.client.cancelOrder({ orderID: orderId });
            logger.info('Order cancelled', { orderId });
        } catch (error) {
            logger.error('Failed to cancel order', { orderId, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get trade history
     */
    async getTrades(): Promise<any[]> {
        if (config.simulationMode) {
            return [];
        }

        if (!this.client) {
            throw new Error('Trading client not initialized');
        }

        try {
            return await this.client.getTrades();
        } catch (error) {
            logger.error('Failed to get trades', { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get user positions from Data API
     */
    async getPositions(userAddress?: string): Promise<Position[]> {
        if (config.simulationMode) {
            return [];
        }

        if (!this.client && !userAddress) {
            throw new Error('Trading client not initialized and no address provided');
        }

        // Use initialized client address if not provided
        const address = userAddress || (this.client as any)?.signer?.address;

        if (!address) {
            logger.warn('No address available to fetch positions');
            return [];
        }

        try {
            const response = await this.dataApiClient.get('/positions', {
                params: {
                    user: address,
                    sizeThreshold: 0.1, // Filter dust
                },
            });

            // Map response to Position interface
            // Expected response: array of objects
            if (Array.isArray(response.data)) {
                return response.data.map((p: any) => ({
                    tokenId: p.asset,
                    marketId: p.conditionId, // Often maps to conditionId or marketId depending on API version
                    marketQuestion: p.title || '',
                    side: p.side === 'YES' ? 'yes' : 'no',
                    size: parseFloat(p.size),
                    avgPrice: parseFloat(p.avgPrice),
                    currentPrice: parseFloat(p.currentPrice || p.avgPrice), // Fallback if current not provided
                    unrealizedPnL: parseFloat(p.unrealizedPnl || 0),
                    entryTime: new Date(p.timestamp || Date.now()), // API might not return timestamp
                }));
            }

            return [];
        } catch (error) {
            logger.error('Failed to get positions', { error: (error as Error).message });
            // Return empty to avoid breaking flows, but log error
            return [];
        }
    }

    /**
     * Check if running in simulation mode
     */
    isSimulationMode(): boolean {
        return config.simulationMode;
    }
}
