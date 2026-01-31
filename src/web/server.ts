
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
