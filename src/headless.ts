
/**
 * Headless Entry Point for PM2
 * Runs the v2 Speed Arbitrage Engine indefinitely (Simulation Mode)
 */

import { SimulationRunner } from './simulation/runner.js';
import { logger } from './logger.js';

async function main() {
    logger.info('🤖 Starting Headless Bot (v2 Speed Arbitrage)...');
    logger.info('Running indefinitely. Press Ctrl+C to stop manually.');

    // Initialize Runner with starting capital $100k and INFINITE cycles
    const runner = new SimulationRunner(100000, Infinity);

    // Handle graceful shutdown
    const shutdown = () => {
        logger.info('🛑 Received shutdown signal. Stopping bot...');
        runner.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await runner.start();
    } catch (error) {
        logger.error('❌ Fatal error in headless runner', { error: (error as Error).message });
        process.exit(1);
    }
}

main();
