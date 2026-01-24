/**
 * Run Portfolio Simulation
 * Simulates trading with $1,000,000 starting capital
 * 
 * Usage: npx tsx src/run-simulation.ts [cycles]
 * Example: npx tsx src/run-simulation.ts 20
 */

import { SimulationRunner } from './simulation/runner.js';
import { config } from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
    // Parse command line args
    const cycles = parseInt(process.argv[2] || '10', 10);

    console.log(`\n🤖 Starting simulation for ${cycles === -1 ? 'infinite' : cycles} cycles...\n`);

    // Create runner with new API (capital, maxCycles)
    const runner = new SimulationRunner(1000000, cycles);

    // Handle shutdown
    process.on('SIGINT', () => {
        logger.info('\nGracefully shutting down...');
        runner.stop();
        process.exit(0);
    });

    try {
        await runner.start();
    } catch (error) {
        logger.error('Simulation failed', { error });
        process.exit(1);
    }
}

main().catch(console.error);
