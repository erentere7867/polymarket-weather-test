/**
 * Polymarket CLOB Trading Client
 * Handles order placement and management
 */

import { ClobClient, Side, OrderType, ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { TradeOrder, OrderBook } from './types.js';

interface MarketInfo {
    tickSize: TickSize;
    negRisk: boolean;
}

export class TradingClient {
    private client: ClobClient | null = null;
    private httpClient: AxiosInstance;
    private initialized: boolean = false;
    private apiCreds: ApiKeyCreds | null = null;

    constructor() {
        this.httpClient = axios.create({
            baseURL: config.clobHost,
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
            throw new Error('PRIVATE_KEY required for live trading');
        }

        try {
            const signer = new Wallet(config.privateKey);

            // Initialize client for API key derivation
            this.client = new ClobClient(config.clobHost, config.chainId, signer);

            // Derive or create API credentials
            this.apiCreds = await this.client.createOrDeriveApiKey();
            logger.info('Derived Polymarket API credentials');

            // Reinitialize with full authentication
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
     * Check if running in simulation mode
     */
    isSimulationMode(): boolean {
        return config.simulationMode;
    }
}
