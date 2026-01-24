/**
 * Run Portfolio Simulation
 * Simulates trading with $1,000,000 starting capital
 * 
 * Usage: npx tsx src/run-simulation.ts [cycles]
 * Example: npx tsx src/run-simulation.ts 20
 */

import { SimulationRunner } from './simulation/index.js';

async function main(): Promise<void> {
    // Parse command line args
    const cycles = parseInt(process.argv[2] || '10', 10);

    console.log(`\n🤖 Starting simulation for ${cycles === -1 ? 'infinite' : cycles} cycles...\n`);

    const runner = new SimulationRunner({
        startingCapital: 1000000,         // $1M starting capital
        maxPositionSize: 50000,           // Max $50K per trade
        minEdgeThreshold: 0.08,           // 8% edge required
        takeProfitPercent: 0.25,          // 25% take profit
        stopLossPercent: 0.15,            // 15% stop loss
        pollIntervalMs: 10000,            // 10 second intervals for fast sim
        simulatePriceChanges: true,       // Simulate price movements
        priceVolatility: 0.03,            // 3% volatility per cycle
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\nShutting down simulation...');
        runner.stop();
    });

    try {
        await runner.run(cycles);
    } catch (error) {
        console.error('Simulation error:', error);
        process.exit(1);
    }
}

main().catch(console.error);
