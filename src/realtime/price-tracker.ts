/**
 * Price Tracker
 * Manages WebSocket subscriptions and updates DataStore with real-time prices
 */

import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherScanner } from '../polymarket/weather-scanner.js';

export class PriceTracker {
    private store: DataStore;

    constructor(store: DataStore) {
        this.store = store;
    }

    /**
     * Start tracking prices via high-frequency polling
     */
    async start(scanner: WeatherScanner, intervalMs: number = 3000): Promise<void> {
        logger.info(`Starting PriceTracker with ${intervalMs}ms polling interval...`);

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
