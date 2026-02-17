/**
 * Polymarket Weather Arbitrage Bot
 * Entry point
 */

import { BotManager } from './bot/manager.js';
import { logger } from './logger.js';
import path from 'path';

// FIXED: Add global unhandled promise rejection handlers
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('Unhandled Promise Rejection', { 
        reason: reason?.message || String(reason), 
        stack: reason?.stack 
    });
});

process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught Exception', { 
        error: error.message, 
        stack: error.stack 
    });
    process.exit(1);
});

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
