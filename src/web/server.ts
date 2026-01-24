
import express from 'express';
import cors from 'cors';
import path from 'path';
import { SimulationRunner } from '../simulation/runner.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Simulation (Indefinite Mode)
const runner = new SimulationRunner(100000, Infinity);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'src/web/public')));

// API Routes

// 1. Status
app.get('/api/status', (req, res) => {
    res.json({
        online: runner.isSimulationRunning(),
        cycles: runner.getCycles(),
        uptime: process.uptime(),
        simulationMode: config.simulationMode
    });
});

// 2. Portfolio
app.get('/api/portfolio', (req, res) => {
    const sim = runner.getSimulator();
    res.json(sim.getPortfolio());
});

// 3. Active Positions
app.get('/api/positions/active', (req, res) => {
    const sim = runner.getSimulator();
    const positions = sim.getOpenPositions().map(p => {
        const state = runner.getStore().getMarketState(p.marketId);
        return {
            ...p,
            marketTitle: state?.market?.eventTitle || p.marketId, // Fallback
            currentPrice: p.currentPrice,
            pnlPercent: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        };
    });
    res.json(positions);
});

// 4. Closed Positions
app.get('/api/positions/closed', (req, res) => {
    const sim = runner.getSimulator();
    // Assuming getClosedPositions exists or we filter from log. 
    // PortfolioSimulator doesn't explicitly expose closed history list publicly in v1 interface?
    // Let's check PortfolioSimulator. If not, we serve stats.
    res.json([]); // Placeholder if accessed directly, or extend PortfolioSimulator later.
});

// 5. Opportunities (Signals)
// Accessing latest signals might require storing them in DataStore or Strategy.
// For now, we return empty list or just valid markets
app.get('/api/opportunities', (req, res) => {
    // This would need strategy state. Skipping for MVP dashboard.
    res.json([]);
});

// Start Server
async function startServer() {
    try {
        // Start Bot
        runner.start(); // This runs in background (async)

        app.listen(PORT, () => {
            logger.info(`🌐 Web Server running on port ${PORT}`);
            logger.info(`📊 Dashboard available at http://localhost:${PORT}`);
        });

    } catch (error) {
        logger.error('Failed to start server', { error: (error as Error).message });
    }
}

// Graceful Shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down server...');
    runner.stop();
    process.exit(0);
});

startServer();
