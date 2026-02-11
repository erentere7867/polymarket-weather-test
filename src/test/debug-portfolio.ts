
import { SimulationRunner } from '../simulation/runner.js';
import { logger } from '../logger.js';

async function main() {
    try {
        const runner = new SimulationRunner(1000000, Infinity);
        console.log('Runner initialized');
        
        const sim = runner.getSimulator();
        const portfolio = sim.getPortfolio();
        
        console.log('Portfolio:', JSON.stringify(portfolio, null, 2));
        
        if (portfolio.currentCash === 1000000) {
            console.log('SUCCESS: Current Cash is 1,000,000');
        } else {
            console.log(`FAILURE: Current Cash is ${portfolio.currentCash}`);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
