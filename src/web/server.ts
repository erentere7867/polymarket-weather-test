
import express from 'express';
import cors from 'cors';
import path from 'path';
import { SimulationRunner } from '../simulation/runner.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { createWebhookRouter } from './tomorrow-webhook.js';
import { webhookValidator } from './middleware/webhook-validator.js';
import { forecastStateMachine, StateContext } from '../realtime/forecast-state-machine.js';
import { eventBus } from '../realtime/event-bus.js';
import { WeatherProviderManager } from '../weather/provider-manager.js';
import { HybridWeatherController, HybridWeatherMode, UrgencyLevel } from '../realtime/hybrid-weather-controller.js';
import { apiCallTracker } from '../realtime/api-call-tracker.js';
import { DataStore } from '../realtime/data-store.js';

const app = express();
const PORT = process.env.PORT || 8188;

/**
 * Tomorrow.io Webhook URL Configuration
 * 
 * Tomorrow.io requires a full HTTPS URL format for webhook endpoints.
 * The URL must include:
 * - Full protocol: https:// (required)
 * - Domain name: your-domain.com or subdomain
 * - Path: /tomorrow (webhook endpoint path)
 * 
 * Correct format examples:
 *   - https://your-domain.com/tomorrow
 *   - https://api.your-domain.com/tomorrow
 *   - https://webhooks.your-domain.com/tomorrow
 * 
 * Incorrect format examples:
 *   - webhooks.erentere7867.com (missing https:// and path)
 *   - http://your-domain.com/tomorrow (must use https)
 *   - your-domain.com:8188/tomorrow (port should not be in public URL)
 * 
 * Note: When configuring webhooks in Tomorrow.io dashboard, always use the
 * full HTTPS URL. The port (8188) is internal and should not appear in the
 * public-facing webhook URL (it's handled by reverse proxy/load balancer).
 */

// Initialize Simulation (Indefinite Mode)
const runner = new SimulationRunner(100000, Infinity);

// Initialize Hybrid Weather Controller
const dataStore = new DataStore();
const hybridWeatherController = new HybridWeatherController(
    forecastStateMachine,
    dataStore
);

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
    const { takeProfit, stopLoss, skipPriceCheck } = req.body;

    if (typeof takeProfit !== 'number' || typeof stopLoss !== 'number') {
        return res.status(400).json({ error: 'Invalid settings format. Expected numbers for takeProfit and stopLoss (percentages).' });
    }

    // Convert from percentage (5) to fraction (0.05)
    // The UI sends 5 for 5%, -10 for -10%
    runner.updateSettings({
        takeProfit: takeProfit / 100,
        stopLoss: stopLoss / 100,
        skipPriceCheck: typeof skipPriceCheck === 'boolean' ? skipPriceCheck : undefined
    });

    res.json({ success: true, message: 'Settings updated' });
});

app.get('/api/settings', (req, res) => {
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
app.post('/api/settings/cache-ttl', (req, res) => {
    const { ttlMs } = req.body;
    if (typeof ttlMs !== 'number' || ttlMs < 0 || ttlMs > 60000) {
        res.status(400).json({ success: false, message: 'Invalid TTL. Must be between 0 and 60000ms' });
        return;
    }
    runner.updateCacheTtl(ttlMs);
    res.json({ success: true, message: `Cache TTL updated to ${ttlMs}ms`, cacheTtlMs: ttlMs });
});

app.get('/api/settings/cache-ttl', (req, res) => {
    res.json({ cacheTtlMs: runner.getCacheTtl() });
});

// 8. Poll Interval Control (Dynamic adjustment)
app.post('/api/settings/poll-interval', (req, res) => {
    const { intervalMs } = req.body;
    if (typeof intervalMs !== 'number' || intervalMs < 1000 || intervalMs > 60000) {
        res.status(400).json({ success: false, message: 'Invalid interval. Must be between 1000 and 60000ms' });
        return;
    }
    runner.updatePollInterval(intervalMs);
    res.json({ success: true, message: `Poll interval updated to ${intervalMs}ms`, pollIntervalMs: intervalMs });
});

app.get('/api/settings/poll-interval', (req, res) => {
    res.json({ pollIntervalMs: runner.getPollInterval() });
});

// 6. Opportunities (Signals)
// Accessing latest signals might require storing them in DataStore or Strategy.
// For now, we return empty list or just valid markets
app.get('/api/opportunities', (req, res) => {
    // This would need strategy state. Skipping for MVP dashboard.
    res.json([]);
});

// 7. Tomorrow.io Webhook Endpoint
// Mount the webhook router at /tomorrow with validation middleware
app.use('/tomorrow', webhookValidator, createWebhookRouter());

// 8. Webhook Status Endpoint
app.get('/api/webhook/status', (req, res) => {
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
app.get('/api/state-machine/stats', (req, res) => {
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
        providerPollIntervalMs: config.PROVIDER_POLL_INTERVAL_MS || 5000,
        idlePollIntervalMinutes: config.IDLE_POLL_INTERVAL_MINUTES || 5,
    });
});

// 10. Provider Health Endpoint
app.get('/api/providers/health', (req, res) => {
    const providerManager = new WeatherProviderManager();
    const providers: Array<{
        name: string;
        isConfigured: boolean;
        isRateLimited: boolean;
        rateLimitResetTime: number;
    }> = [];

    // Get all available providers
    const allProviders = [
        { name: 'open-meteo', key: '' }, // Always available
        { name: 'openweather', key: config.openWeatherApiKey },
        { name: 'tomorrow', key: config.tomorrowApiKey },
        { name: 'weatherapi', key: config.weatherApiKey },
        { name: 'weatherbit', key: config.weatherbitApiKey },
        { name: 'visualcrossing', key: config.visualCrossingApiKey },
        { name: 'meteosource', key: config.meteosourceApiKey },
    ];

    for (const provider of allProviders) {
        const isConfigured = provider.name === 'open-meteo' || !!provider.key;
        providers.push({
            name: provider.name,
            isConfigured,
            isRateLimited: providerManager.isProviderRateLimited(provider.name),
            rateLimitResetTime: providerManager.getRateLimitResetTime(provider.name),
        });
    }

    res.json({
        providers,
        totalProviders: providers.length,
        configuredProviders: providers.filter(p => p.isConfigured).length,
        rateLimitedProviders: providers.filter(p => p.isRateLimited).length,
    });
});

// 11. Forecast Trigger Statistics
app.get('/api/forecast/triggers', (req, res) => {
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
app.get('/api/hybrid-weather/status', (req, res) => {
    const status = hybridWeatherController.getStatusReport();
    res.json({
        currentMode: status.state.currentMode,
        previousMode: status.state.previousMode,
        modeDuration: status.modeDuration,
        isRunning: status.state.isRunning,
        currentUrgency: status.state.currentUrgency,
        modeConfig: status.modeConfig,
        burstActive: status.burstActive,
        websocketActive: status.websocketActive,
        openMeteoPollingActive: status.openMeteoPollingActive,
        burstProgress: status.burstProgress,
        nextUrgencyWindow: status.nextUrgencyWindow,
        isAutoMode: status.isAutoMode,
    });
});

// 13. API Call Tracker Status with Quota Information
app.get('/api/api-calls/status', (req, res) => {
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
app.post('/api/hybrid-weather/burst', async (req, res) => {
    const { cityId } = req.body;
    if (!cityId) {
        res.status(400).json({ error: 'cityId is required' });
        return;
    }
    
    await hybridWeatherController.triggerBurstMode(cityId);
    res.json({ success: true, message: `Burst mode triggered for ${cityId}` });
});

// 15. Return to Normal Mode (Manual)
// This re-enables auto-switching based on urgency windows
app.post('/api/hybrid-weather/normal', async (req, res) => {
    await hybridWeatherController.returnToNormal();
    const status = hybridWeatherController.getStatusReport();
    res.json({
        success: true,
        message: 'Returned to automatic mode - auto-switching enabled',
        currentMode: status.state.currentMode,
        currentUrgency: status.state.currentUrgency,
        isAutoMode: true,
    });
});

// 16. Force Mode Transition (Emergency/Manual Override)
app.post('/api/hybrid-weather/force-mode', async (req, res) => {
    const { mode, reason } = req.body;
    const validModes: HybridWeatherMode[] = ['OPEN_METEO_POLLING', 'METEOSOURCE_POLLING', 'WEBSOCKET_REST', 'ROUND_ROBIN_BURST'];
    
    if (!mode || !validModes.includes(mode)) {
        res.status(400).json({
            error: 'Invalid mode. Must be one of: OPEN_METEO_POLLING, METEOSOURCE_POLLING, WEBSOCKET_REST, ROUND_ROBIN_BURST'
        });
        return;
    }
    
    await hybridWeatherController.forceMode(mode, reason || 'manual');
    res.json({ success: true, message: `Forced transition to ${mode}` });
});

// 17. Get Urgency Window Schedule
app.get('/api/hybrid-weather/urgency-schedule', (req, res) => {
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
app.get('/api/hybrid-weather/history', (req, res) => {
    const state = hybridWeatherController.getState();
    res.json({
        modeHistory: state.modeHistory,
        lastTransition: state.lastTransition,
    });
});

// 19. Toggle Mode (Convenience endpoint for dashboard)
// NOTE: This disables auto mode since it's a manual override
app.post('/api/hybrid-weather/toggle', async (req, res) => {
    const currentMode = hybridWeatherController.getCurrentMode();
    const currentUrgency = hybridWeatherController.getCurrentUrgency();
    
    let targetMode: HybridWeatherMode;
    
    // Cycle through modes: WEBSOCKET_REST -> OPEN_METEO_POLLING -> ROUND_ROBIN_BURST -> WEBSOCKET_REST
    switch (currentMode) {
        case 'WEBSOCKET_REST':
            targetMode = 'OPEN_METEO_POLLING';
            break;
        case 'OPEN_METEO_POLLING':
            targetMode = 'ROUND_ROBIN_BURST';
            break;
        case 'ROUND_ROBIN_BURST':
            targetMode = 'WEBSOCKET_REST';
            break;
        default:
            targetMode = currentUrgency === 'LOW' ? 'WEBSOCKET_REST' : 'OPEN_METEO_POLLING';
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

// Start Server
async function startServer() {
    try {
        // Start Bot
        runner.start(); // This runs in background (async)

        // Start Hybrid Weather Controller
        hybridWeatherController.start();
        logger.info('🌤️ Hybrid Weather Controller started');

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
    hybridWeatherController.stop();
    process.exit(0);
});

startServer();
