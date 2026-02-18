import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { SimulationRunner } from '../simulation/runner.js';
import { logger } from '../logger.js';
import { config, DASHBOARD_THRESHOLDS } from '../config.js';
import { createWebhookRouter } from './tomorrow-webhook.js';
import { webhookValidator } from './middleware/webhook-validator.js';
import { forecastStateMachine, StateContext } from '../realtime/forecast-state-machine.js';
import { eventBus } from '../realtime/event-bus.js';
import { HybridWeatherController, HybridWeatherMode } from '../realtime/hybrid-weather-controller.js';
import { apiCallTracker } from '../realtime/api-call-tracker.js';
import { DataStore } from '../realtime/data-store.js';
import { FileBasedIngestion } from '../weather/file-based-ingestion.js';
import { ScheduleManager } from '../weather/schedule-manager.js';
import { DashboardController, createDashboardRouter } from './dashboard-controller.js';

const dashboardApp = express();
const webhookApp = express();

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8034;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 8188;

// Initialize Simulation (Indefinite Mode) - $1,000,000 starting capital
const runner = new SimulationRunner(1000000, Infinity);
logger.info(`[Server] SimulationRunner created. Simulator cash: $${runner.getSimulator().getCashBalance()}`);

// Initialize Hybrid Weather Controller
const dataStore = new DataStore();
const hybridWeatherController = new HybridWeatherController(
    forecastStateMachine,
    dataStore
);

// Initialize File-Based Ingestion System
const fileBasedIngestion = new FileBasedIngestion({
    enabled: true,
    s3PollIntervalMs: 150,
    maxDetectionDurationMs: 45 * 60 * 1000,
    awsRegion: 'us-east-1',
    publicBuckets: true,
});

// Initialize Schedule Manager
const scheduleManager = new ScheduleManager();

// Initialize Dashboard Controller
const dashboardController = new DashboardController(
    dataStore,
    fileBasedIngestion,
    scheduleManager
);

// Middleware (Dashboard)
dashboardApp.use(compression());
dashboardApp.use(cors());
dashboardApp.use(express.json());
dashboardApp.use(express.static(path.join(process.cwd(), 'src/web/public')));

// Middleware (Webhook)
webhookApp.use(cors());
webhookApp.use(express.json());

// ========================
// API Routes (Dashboard)
// ========================

// 1. Status
dashboardApp.get('/api/status', (req, res) => {
    const cycles = runner.getCycles();
    const uptime = process.uptime();
    // Calculate cycles per minute for more meaningful display
    const cyclesPerMinute = uptime > 0 ? Math.round((cycles / uptime) * 60) : 0;

    res.json({
        online: runner.isSimulationRunning(),
        cycles: cycles,
        cyclesPerMinute: cyclesPerMinute,
        uptime: uptime,
        simulationMode: config.simulationMode
    });
});

// 2. Portfolio
dashboardApp.get('/api/portfolio', (req, res) => {
    const sim = runner.getSimulator();
    const portfolio = sim.getPortfolio();
    logger.debug(`[API /portfolio] Returning portfolio:`, portfolio);
    res.json(portfolio);
});

// 3. Active Positions
dashboardApp.get('/api/positions/active', (req, res) => {
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
dashboardApp.get('/api/positions/closed', (req, res) => {
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
dashboardApp.post('/api/settings', (req, res) => {
    const { takeProfit, stopLoss, skipPriceCheck } = req.body;

    if (typeof takeProfit !== 'number' || typeof stopLoss !== 'number') {
        return res.status(400).json({ error: 'Invalid settings format. Expected numbers for takeProfit and stopLoss (percentages).' });
    }

    // Convert from percentage (5) to fraction (0.05)
    // The UI sends 5 for 5%, -10 for -10%
    runner.updateSettings({
        takeProfit: takeProfit / 100,
        stopLoss: stopLoss / 100,
        skipPriceCheck: typeof skipPriceCheck === 'boolean' ? skipPriceCheck : undefined,
    });

    res.json({ success: true, message: 'Settings updated' });
});

dashboardApp.get('/api/settings', (req, res) => {
    const settings = runner.getSettings();
    // Return as percentages for UI
    res.json({
        takeProfit: settings.takeProfit * 100,
        stopLoss: settings.stopLoss * 100,
        skipPriceCheck: settings.skipPriceCheck,
        cacheTtlMs: runner.getCacheTtl(),
        pollIntervalMs: runner.getPollInterval()
    });
});

// 7. Cache TTL Control (Dynamic adjustment)
dashboardApp.post('/api/settings/cache-ttl', (req, res) => {
    const { ttlMs } = req.body;
    if (typeof ttlMs !== 'number' || ttlMs < 0 || ttlMs > 60000) {
        res.status(400).json({ success: false, message: 'Invalid TTL. Must be between 0 and 60000ms' });
        return;
    }
    runner.updateCacheTtl(ttlMs);
    res.json({ success: true, message: `Cache TTL updated to ${ttlMs}ms`, cacheTtlMs: ttlMs });
});

dashboardApp.get('/api/settings/cache-ttl', (req, res) => {
    res.json({ cacheTtlMs: runner.getCacheTtl() });
});

// 8. Poll Interval Control (Dynamic adjustment)
dashboardApp.post('/api/settings/poll-interval', (req, res) => {
    const { intervalMs } = req.body;
    if (typeof intervalMs !== 'number' || intervalMs < 1000 || intervalMs > 60000) {
        res.status(400).json({ success: false, message: 'Invalid interval. Must be between 1000 and 60000ms' });
        return;
    }
    runner.updatePollInterval(intervalMs);
    res.json({ success: true, message: `Poll interval updated to ${intervalMs}ms`, pollIntervalMs: intervalMs });
});

dashboardApp.get('/api/settings/poll-interval', (req, res) => {
    res.json({ pollIntervalMs: runner.getPollInterval() });
});

// 6. Opportunities (Signals)
// Accessing latest signals might require storing them in DataStore or Strategy.
// For now, we return empty list or just valid markets
dashboardApp.get('/api/opportunities', (req, res) => {
    // This would need strategy state. Skipping for MVP dashboard.
    res.json([]);
});

// 8. Webhook Status Endpoint (on Dashboard)
dashboardApp.get('/api/webhook/status', (req, res) => {
    const stats = eventBus.getEventStats();
    res.json({
        webhookMode: config.USE_WEBHOOK_MODE,
        webhookSecretConfigured: !!config.TOMORROW_WEBHOOK_SECRET,
        lastWebhookTime: stats.lastWebhookTime,
        webhooksReceived: stats.webhooksReceived,
        webhooksProcessed: stats.webhooksProcessed,
        uptime: process.uptime(),
    });
});

// 9. State Machine Stats Endpoint
dashboardApp.get('/api/state-machine/stats', (req, res) => {
    const stats = forecastStateMachine.getStats();
    const allCityStates: Array<{
        cityId: string;
        state: string;
        fetchModeEntryTime: string | null;
        lastForecastChange: string | null;
        providerErrorCounts: Record<string, number>;
    }> = [];

    // Get detailed state for each city
    for (const cityId of stats.citiesInFetchMode) {
        const context = forecastStateMachine.getContext(cityId);
        const errorCounts: Record<string, number> = {};
        context.providerErrorCounts.forEach((count, provider) => {
            errorCounts[provider] = count;
        });
        allCityStates.push({
            cityId,
            state: context.state,
            fetchModeEntryTime: context.fetchModeEntryTime?.toISOString() || null,
            lastForecastChange: context.lastForecastChange?.toISOString() || null,
            providerErrorCounts: errorCounts,
        });
    }

    // Also include IDLE cities
    const idleCities = forecastStateMachine.getCitiesInIdle();
    for (const cityId of idleCities) {
        const context = forecastStateMachine.getContext(cityId);
        const errorCounts: Record<string, number> = {};
        context.providerErrorCounts.forEach((count, provider) => {
            errorCounts[provider] = count;
        });
        allCityStates.push({
            cityId,
            state: context.state,
            fetchModeEntryTime: null,
            lastForecastChange: context.lastForecastChange?.toISOString() || null,
            providerErrorCounts: errorCounts,
        });
    }

    res.json({
        ...stats,
        cities: allCityStates,
        fetchModeTimeoutMinutes: config.FETCH_MODE_TIMEOUT_MINUTES || 10,
        noChangeExitMinutes: config.NO_CHANGE_EXIT_MINUTES || 5,
        idlePollIntervalMinutes: config.IDLE_POLL_INTERVAL_MINUTES || 5,
    });
});

// 10. Provider Health Endpoint (disabled - API code removed)
dashboardApp.get('/api/providers/health', (req, res) => {
    res.json({ status: 'disabled', message: 'Provider health checks removed' });
});

// 11. Forecast Trigger Statistics
dashboardApp.get('/api/forecast/triggers', (req, res) => {
    const stats = forecastStateMachine.getStats();
    const eventStats = eventBus.getEventStats();

    res.json({
        totalCities: stats.totalCities,
        citiesInFetchMode: stats.citiesInFetchMode,
        citiesInIdle: stats.inIdle,
        fetchCyclesCompleted: eventStats.fetchCyclesCompleted,
        webhooksReceived: eventStats.webhooksReceived,
        lastTriggerTime: eventStats.lastTriggerTime,
        mode: config.USE_WEBHOOK_MODE ? 'webhook-driven' : 'polling-only',
    });
});

// ============================================
// HYBRID WEATHER CONTROLLER DASHBOARD ENDPOINTS
// ============================================

// 12. Hybrid Weather Controller Status
dashboardApp.get('/api/hybrid-weather/status', (req, res) => {
    const status = hybridWeatherController.getStatusReport();
    res.json({
        currentMode: status.state.currentMode,
        previousMode: status.state.previousMode,
        modeDuration: status.modeDuration,
        isRunning: status.state.isRunning,
        currentDetectionWindow: status.state.currentDetectionWindow,
        modeConfig: status.modeConfig,
        burstActive: status.burstActive,
        pollingActive: status.pollingActive,
        burstProgress: status.burstProgress,
        nextDetectionWindow: status.nextDetectionWindow,
        isAutoMode: status.isAutoMode,
    });
});

// 13. API Call Tracker Status with Quota Information
dashboardApp.get('/api/api-calls/status', (req, res) => {
    const status = apiCallTracker.getStatusReport();
    res.json({
        date: status.date,
        totalCalls: status.totalCalls,
        estimatedCost: status.estimatedCost,
        burstMode: status.burstMode,
        providers: status.providers.map(p => ({
            provider: p.provider,
            callCount: p.callCount,
            dailyLimit: p.dailyLimit,
            hardQuotaLimit: p.hardQuotaLimit,
            usagePercentage: p.dailyLimit ? ((p.callCount / p.dailyLimit) * 100).toFixed(2) + '%' : 'N/A (unlimited)',
            quotaUsagePercentage: p.hardQuotaLimit ? ((p.callCount / p.hardQuotaLimit) * 100).toFixed(2) + '%' : 'N/A (no quota)',
            isRateLimited: p.isRateLimited,
            isQuotaExceeded: p.isQuotaExceeded,
            lastCallTime: p.lastCallTime,
        })),
    });
});

// 14. Trigger Burst Mode (Manual)
dashboardApp.post('/api/hybrid-weather/burst', async (req, res) => {
    const { cityId } = req.body;
    if (!cityId) {
        res.status(400).json({ error: 'cityId is required' });
        return;
    }
    
    await hybridWeatherController.triggerBurstMode(cityId);
    res.json({ success: true, message: `Burst mode triggered for ${cityId}` });
});

// 15. Return to Auto Mode (Manual)
// This re-enables auto-switching based on detection windows
dashboardApp.post('/api/hybrid-weather/normal', async (req, res) => {
    await hybridWeatherController.returnToAutoMode();
    const status = hybridWeatherController.getStatusReport();
    res.json({
        success: true,
        message: 'Returned to automatic mode - auto-switching enabled',
        currentMode: status.state.currentMode,
        currentDetectionWindow: status.state.currentDetectionWindow,
        isAutoMode: true,
    });
});

// 16. Force Mode Transition (Emergency/Manual Override)
dashboardApp.post('/api/hybrid-weather/force-mode', async (req, res) => {
    const { mode, reason } = req.body;
    const validModes: HybridWeatherMode[] = ['DETECTION_POLLING', 'WEBSOCKET_IDLE', 'BURST_MODE'];
    
    if (!mode || !validModes.includes(mode)) {
        res.status(400).json({
            error: 'Invalid mode. Must be one of: DETECTION_POLLING, WEBSOCKET_IDLE, BURST_MODE'
        });
        return;
    }
    
    await hybridWeatherController.forceMode(mode, reason || 'manual');
    res.json({ success: true, message: `Forced transition to ${mode}` });
});

// 17. Get Urgency Window Schedule
dashboardApp.get('/api/hybrid-weather/urgency-schedule', (req, res) => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const currentTime = utcHour * 60 + utcMinute;

    // Urgency window definitions
    const windows = [
        { level: 'HIGH', startHour: 0, startMinute: 30, endHour: 2, endMinute: 30, pollIntervalMs: 2000 },
        { level: 'HIGH', startHour: 12, startMinute: 30, endHour: 14, endMinute: 30, pollIntervalMs: 2000 },
        { level: 'MEDIUM', startHour: 6, startMinute: 30, endHour: 7, endMinute: 30, pollIntervalMs: 5000 },
        { level: 'MEDIUM', startHour: 18, startMinute: 30, endHour: 19, endMinute: 30, pollIntervalMs: 5000 },
    ];

    // Determine current urgency
    let currentUrgency = 'LOW';
    for (const window of windows) {
        const startTime = window.startHour * 60 + window.startMinute;
        const endTime = window.endHour * 60 + window.endMinute;
        if (currentTime >= startTime && currentTime < endTime) {
            currentUrgency = window.level;
            break;
        }
    }

    res.json({
        currentUrgency,
        currentUTCTime: `${utcHour.toString().padStart(2, '0')}:${utcMinute.toString().padStart(2, '0')}`,
        windows: windows.map(w => ({
            level: w.level,
            start: `${w.startHour.toString().padStart(2, '0')}:${w.startMinute.toString().padStart(2, '0')}`,
            end: `${w.endHour.toString().padStart(2, '0')}:${w.endMinute.toString().padStart(2, '0')}`,
            pollIntervalMs: w.pollIntervalMs,
            pollIntervalSec: w.pollIntervalMs / 1000,
        })),
    });
});

// 18. Get Mode History
dashboardApp.get('/api/hybrid-weather/history', (req, res) => {
    const state = hybridWeatherController.getState();
    res.json({
        modeHistory: state.modeHistory,
        lastTransition: state.lastTransition,
    });
});

// 19. Toggle Mode (Convenience endpoint for dashboard)
// NOTE: This disables auto mode since it's a manual override
dashboardApp.post('/api/hybrid-weather/toggle', async (req, res) => {
    const currentMode = hybridWeatherController.getCurrentMode();
    
    let targetMode: HybridWeatherMode;
    
    // Cycle through modes: WEBSOCKET_IDLE -> DETECTION_POLLING -> BURST_MODE -> WEBSOCKET_IDLE
    switch (currentMode) {
        case 'WEBSOCKET_IDLE':
            targetMode = 'DETECTION_POLLING';
            break;
        case 'DETECTION_POLLING':
            targetMode = 'BURST_MODE';
            break;
        case 'BURST_MODE':
            targetMode = 'WEBSOCKET_IDLE';
            break;
        default:
            targetMode = 'WEBSOCKET_IDLE';
    }
    
    await hybridWeatherController.forceMode(targetMode, 'manual_toggle');
    res.json({
        success: true,
        message: `Toggled from ${currentMode} to ${targetMode} (Auto mode disabled)`,
        previousMode: currentMode,
        currentMode: targetMode,
        isAutoMode: false,
    });
});

// 20. Confidence Compression Stats (from SimulationRunner)
dashboardApp.get('/api/confidence', (req, res) => {
    const perf = runner.getComponentPerformance();
    const markets = runner.getStore().getAllMarkets();
    const strategyStats = runner.getStrategy().getStats();
    const sim = runner.getSimulator();
    
    // Calculate average confidence from open positions
    const openPositions = sim.getOpenPositions();
    const avgConfidenceScore = openPositions.length > 0 
        ? openPositions.reduce((sum, p) => sum + ((p as any).confidence || 0), 0) / openPositions.length 
        : 0;
    
    res.json({
        totalMarketsAnalyzed: markets.length,
        firstRunBlocks: strategyStats.blockReasons.FIRST_RUN,
        stabilityBlocks: strategyStats.blockReasons.STABILITY_CHECK_FAILED,
        confidenceBlocks: strategyStats.blockReasons.CONFIDENCE_BELOW_THRESHOLD,
        signalsGenerated: perf.confidenceCompression.signalsGenerated,
        tradesExecuted: perf.confidenceCompression.tradesExecuted,
        avgConfidenceScore,
        avgExecutionTimeMs: perf.confidenceCompression.avgExecutionTimeMs,
        totalPnl: perf.confidenceCompression.totalPnl,
        crossMarketOpportunities: perf.crossMarketArbitrage.opportunitiesDetected,
        consideredTrades: strategyStats.consideredTrades,
        rejectedTrades: strategyStats.blockedTrades,
        confirmationBypasses: strategyStats.confirmationBypasses,
        blockReasons: strategyStats.blockReasons,
        modelHierarchy: {
            us: { primary: 'HRRR', secondary: 'RAP', regime: 'GFS' },
            eu: { primary: 'ECMWF', secondary: 'GFS' },
        },
        thresholds: DASHBOARD_THRESHOLDS,
    });
});

// 21. Mount Dashboard Router
dashboardApp.use('/api/dashboard', createDashboardRouter(dashboardController));

// 22. Batched Dashboard Poll — single endpoint for all periodic data
dashboardApp.get('/api/poll', (req, res) => {
    const sim = runner.getSimulator();
    const cycles = runner.getCycles();
    const uptime = process.uptime();
    const eventStats = eventBus.getEventStats();
    const perf = runner.getComponentPerformance();
    const markets = runner.getStore().getAllMarkets();
    const strategyStats = runner.getStrategy().getStats();

    const activePositions = sim.getOpenPositions().map(p => {
        const state = runner.getStore().getMarketState(p.marketId);
        return {
            ...p,
            marketTitle: state?.market?.eventTitle || p.marketId,
            currentPrice: p.currentPrice,
            pnlPercent: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        };
    });

    const closedPositions = sim.getClosedPositions().map(p => {
        const holdDurationMs = p.exitTime && p.entryTime
            ? p.exitTime.getTime() - p.entryTime.getTime()
            : 0;
        const pnlPercent = p.entryPrice > 0
            ? ((p.exitPrice || 0) - p.entryPrice) / p.entryPrice * 100
            : 0;
        return {
            id: p.id, marketQuestion: p.marketQuestion, side: p.side,
            shares: p.shares, entryPrice: p.entryPrice,
            exitPrice: p.exitPrice || 0, entryTime: p.entryTime,
            exitTime: p.exitTime, realizedPnL: p.realizedPnL || 0,
            pnlPercent, holdDurationSeconds: Math.floor(holdDurationMs / 1000),
            status: p.status
        };
    }).reverse();

    // Calculate win/lose ratio from closed positions
    const allClosedPositions = sim.getClosedPositions();
    const wins = allClosedPositions.filter(p => (p.realizedPnL || 0) > 0).length;
    const losses = allClosedPositions.filter(p => (p.realizedPnL || 0) < 0).length;
    const draws = allClosedPositions.length - wins - losses;
    const winRate = allClosedPositions.length > 0 ? (wins / allClosedPositions.length) * 100 : 0;

    res.json({
        status: {
            online: runner.isSimulationRunning(),
            cycles,
            cyclesPerMinute: uptime > 0 ? Math.round((cycles / uptime) * 60) : 0,
            uptime,
        },
        portfolio: sim.getPortfolio(),
        activePositions,
        closedPositions,
        webhook: {
            webhooksReceived: eventStats.webhooksReceived,
            fetchCyclesCompleted: eventStats.fetchCyclesCompleted,
        },
        confidence: {
            totalMarketsAnalyzed: markets.length,
            firstRunBlocks: strategyStats.blockReasons.FIRST_RUN,
            stabilityBlocks: strategyStats.blockReasons.STABILITY_CHECK_FAILED,
            confidenceBlocks: strategyStats.blockReasons.CONFIDENCE_BELOW_THRESHOLD,
            signalsGenerated: perf.confidenceCompression.signalsGenerated,
            tradesExecuted: perf.confidenceCompression.tradesExecuted,
            thresholds: DASHBOARD_THRESHOLDS,
        },
        weather: {
            status: dashboardController.getSystemStatus(),
            models: dashboardController.getModelStatus(),
            cities: dashboardController.getCityCoverage(),
            latency: dashboardController.getLatencyMetrics(),
            apiFallback: dashboardController.getApiFallbackStatus(),
            events: dashboardController.getRecentEvents(20),
            windows: dashboardController.getActiveWindows(),
            upcoming: dashboardController.getUpcomingRuns(5),
        },
        marketAnalysis: runner.getMarketAnalysis(),
        winLossStats: {
            wins,
            losses,
            draws,
            winRate: winRate.toFixed(1),
            totalTrades: allClosedPositions.length
        },
    });
});

// ========================
// Webhook Routes (Webhook)
// ========================

// 7. Tomorrow.io Webhook Endpoint
// Mount the webhook router at /tomorrow with validation middleware
webhookApp.use('/tomorrow', webhookValidator, createWebhookRouter());

// Start Server
async function startServer() {
    try {
        // Start Bot
        runner.start(); // This runs in background (async)

        // Start Hybrid Weather Controller
        hybridWeatherController.start();
        logger.info('🌤️ Hybrid Weather Controller started');

        // Start File-Based Ingestion
        fileBasedIngestion.start();
        logger.info('📁 File-Based Ingestion started');

        // Create HTTP server for Dashboard (Express + WebSocket)
        const dashboardServer = createServer(dashboardApp);

        // Setup WebSocket server for dashboard real-time updates
        const wss = new WebSocketServer({ server: dashboardServer, path: '/ws/dashboard' });
        dashboardController.setupWebSocketServer(wss);
        logger.info('🔌 Dashboard WebSocket server initialized');

        // Start Dashboard Server
        dashboardServer.listen(DASHBOARD_PORT, () => {
            logger.info(`🌐 Dashboard Web Server running on port ${DASHBOARD_PORT}`);
            logger.info(`📊 Dashboard available at http://localhost:${DASHBOARD_PORT}`);
            logger.info(`🔌 WebSocket endpoint: ws://localhost:${DASHBOARD_PORT}/ws/dashboard`);
        });

        // Start Webhook Server
        const webhookServer = createServer(webhookApp);
        webhookServer.listen(WEBHOOK_PORT, () => {
             logger.info(`🪝 Webhook Listener running on port ${WEBHOOK_PORT}`);
             logger.info(`📡 Webhook endpoint: http://localhost:${WEBHOOK_PORT}/tomorrow`);
        });

    } catch (error) {
        logger.error('Failed to start server', { error: (error as Error).message });
    }
}

// Graceful Shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down server...');
    runner.stop();
    hybridWeatherController.stop();
    fileBasedIngestion.stop();
    dashboardController.destroy();
    process.exit(0);
});

startServer();