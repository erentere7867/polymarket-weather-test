
import express from 'express';
import cors from 'cors';
import path from 'path';
import { SimulationRunner } from '../simulation/runner.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const app = express();
const PORT = process.env.PORT || 3000;

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
        simulationMode: config.simulationMode,
        debug: runner.getDebugStats()
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
            marketTitle: p.marketQuestion || state?.market?.eventTitle || p.marketId, // Use specific question
            currentPrice: p.currentPrice,
            pnlPercent: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        };
    });
    res.json(positions);
});

// 4. Closed Positions
app.get('/api/positions/closed', (req, res) => {
    const sim = runner.getSimulator();
    const closedPositions = sim.getClosedPositions().map(p => {
        const holdDurationMs = p.exitTime && p.entryTime
            ? p.exitTime.getTime() - p.entryTime.getTime()
            : 0;
        const holdDurationSeconds = Math.floor(holdDurationMs / 1000);
        const pnlPercent = p.entryPrice > 0
            ? ((p.exitPrice || 0) - p.entryPrice) / p.entryPrice * 100
            : 0;

        return {
            id: p.id,
            marketQuestion: p.marketQuestion,
            side: p.side,
            shares: p.shares,
            entryPrice: p.entryPrice,
            exitPrice: p.exitPrice || 0,
            entryTime: p.entryTime,
            exitTime: p.exitTime,
            realizedPnL: p.realizedPnL || 0,
            pnlPercent: pnlPercent,
            holdDurationSeconds: holdDurationSeconds,
            status: p.status
        };
    });
    // Return most recent first
    res.json(closedPositions.reverse());
});

// 5. Settings Update
app.post('/api/settings', (req, res) => {
    const { takeProfit, stopLoss } = req.body;

    if (typeof takeProfit !== 'number' || typeof stopLoss !== 'number') {
        return res.status(400).json({ error: 'Invalid settings format. Expected numbers for takeProfit and stopLoss (percentages).' });
    }

    // Convert from percentage (5) to fraction (0.05)
    // The UI sends 5 for 5%, -10 for -10%
    runner.updateSettings({
        takeProfit: takeProfit / 100,
        stopLoss: stopLoss / 100
    });

    res.json({ success: true, message: 'Settings updated' });
});

app.get('/api/settings', (req, res) => {
    const settings = runner.getSettings();
    // Return as percentages for UI
    res.json({
        takeProfit: settings.takeProfit * 100,
        stopLoss: settings.stopLoss * 100
    });
});

// 6. Opportunities (Signals)
// Accessing latest signals might require storing them in DataStore or Strategy.
// For now, we return empty list or just valid markets
app.get('/api/opportunities', (req, res) => {
    // This would need strategy state. Skipping for MVP dashboard.
    res.json([]);
});

// Initialize runner lazily or inside startServer to catch errors
let runner: SimulationRunner;

// Start Server
async function startServer() {
    try {
        logger.info('🚀 Initializing SimulationRunner...');
        // Initialize Simulation (Indefinite Mode)
        runner = new SimulationRunner(100000, Infinity);

        // Start Bot background loop
        logger.info('🔄 Starting Racing Logic...');
        runner.start().catch(err => {
            logger.error('❌ Racing Logic Crashed:', err);
        });

        app.listen(PORT, () => {
            logger.info('='.repeat(50));
            logger.info(`🌐 Web Server running on port ${PORT}`);
            logger.info(`📊 Dashboard available at http://localhost:${PORT}`);
            logger.info('='.repeat(50));
        });

    } catch (error) {
        logger.error('❌ Failed to start server:', { error: (error as Error).message, stack: (error as Error).stack });
        process.exit(1);
    }
}

// Routes need to check if runner exists
app.use((req, res, next) => {
    if (!runner) {
        return res.status(503).json({ error: 'Server initializing...' });
    }
    next();
});


// Graceful Shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down server...');
    runner.stop();
    process.exit(0);
});

startServer();
