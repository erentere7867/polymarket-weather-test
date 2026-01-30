/**
 * Polymarket Weather Arbitrage Bot
 * Entry point
 */

import { BotManager } from './bot/manager.js';
import { logger } from './logger.js';
import path from 'path';

async function main(): Promise<void> {
    const bot = new BotManager();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        logger.info('Received SIGINT, shutting down...');
        bot.stop();
    });

    process.on('SIGTERM', () => {
        logger.info('Received SIGTERM, shutting down...');
        bot.stop();
    });

    try {
        await bot.initialize();
        await bot.start();
    } catch (error) {
        logger.error('Fatal error', { error: (error as Error).message, stack: (error as Error).stack });
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
