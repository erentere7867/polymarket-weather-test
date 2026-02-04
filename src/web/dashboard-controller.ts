/**
 * Dashboard Controller
 * Provides REST endpoints and WebSocket/SSE for real-time dashboard updates
 * Aggregates data from FileBasedIngestion, ScheduleManager, DataStore, and EventBus
 */

import { Router, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { EventBus, eventBus } from '../realtime/event-bus.js';
import { DataStore } from '../realtime/data-store.js';
import { FileBasedIngestion } from '../weather/file-based-ingestion.js';
import { ScheduleManager } from '../weather/schedule-manager.js';
import { ApiFallbackPoller } from '../weather/api-fallback-poller.js';
import { ModelType, DetectionWindow, CityModelConfig, CITY_MODEL_CONFIGS } from '../weather/types.js';
import { logger } from '../logger.js';

/**
 * Operational mode for file ingestion
 */
type OperationalMode = 'FILE_PRIMARY' | 'API_FALLBACK' | 'BOTH' | 'INACTIVE';

/**
 * Model status for dashboard
 */
interface ModelStatus {
    model: ModelType;
    lastRun: string | null;
    nextExpected: string | null;
    status: 'WAITING' | 'DETECTING' | 'CONFIRMED' | 'TIMEOUT' | 'ERROR';
    progress: number; // 0-100
    cycleHour: number | null;
}

/**
 * City coverage data for dashboard
 */
interface CityCoverage {
    cityId: string;
    cityName: string;
    primaryModel: ModelType;
    lastUpdate: string | null;
    confirmationStatus: 'FILE_CONFIRMED' | 'API_UNCONFIRMED' | 'STALE';
    temperature: number | null;
    windSpeed: number | null;
    precipitation: number | null;
    temperatureChange: number | null;
    windChange: number | null;
    precipChange: number | null;
}

/**
 * Latency metrics for dashboard
 */
interface LatencyMetrics {
    detection: { last: number; average: number; p95: number; count: number };
    download: { last: number; average: number; p95: number; count: number };
    parse: { last: number; average: number; p95: number; count: number };
    endToEnd: { last: number; average: number; p95: number; count: number; withinBudget: boolean };
}

/**
 * API fallback status for dashboard
 */
interface ApiFallbackStatus {
    status: 'ACTIVE' | 'INACTIVE' | 'STANDBY';
    activeSessions: number;
    totalPollsInWindow: number;
    lastApiUpdate: string | null;
    fileConfirmations: number;
    apiConfirmations: number;
    ratio: string;
}

/**
 * Dashboard event for event log
 */
interface DashboardEvent {
    id: string;
    type: string;
    timestamp: string;
    city?: string;
    model?: ModelType;
    message: string;
    confidence?: 'HIGH' | 'LOW';
    severity: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Overall system status
 */
interface SystemStatus {
    status: 'ACTIVE' | 'INACTIVE' | 'DEGRADED';
    mode: OperationalMode;
    activeDetectionWindows: number;
    lastFileConfirmation: string | null;
    uptime: number;
    version: string;
}

/**
 * Dashboard Controller
 * Manages dashboard data aggregation and real-time updates
 */
export class DashboardController {
    private eventBus: EventBus;
    private dataStore: DataStore;
    private fileIngestion?: FileBasedIngestion;
    private scheduleManager?: ScheduleManager;
    private apiFallbackPoller?: ApiFallbackPoller;
    private wss?: WebSocketServer;
    private clients: Set<WebSocket> = new Set();
    private unsubscribers: (() => void)[] = [];
    private startTime: Date = new Date();

    // Cached dashboard data
    private cachedStatus: SystemStatus | null = null;
    private cachedModelStatus: ModelStatus[] = [];
    private cachedCityCoverage: CityCoverage[] = [];
    private cachedEvents: DashboardEvent[] = [];
    private readonly MAX_CACHED_EVENTS = 100;

    // Throttling and deduplication
    private lastBroadcastTime: number = 0;
    private readonly BROADCAST_THROTTLE_MS = 1000; // Minimum 1 second between broadcasts
    private pendingBroadcasts: Map<string, { payload: unknown; timestamp: number }> = new Map();
    private lastBroadcastData: Map<string, string> = new Map(); // For deduplication
    private broadcastTimeout: NodeJS.Timeout | null = null;

    constructor(
        dataStore: DataStore,
        fileIngestion?: FileBasedIngestion,
        scheduleManager?: ScheduleManager,
        apiFallbackPoller?: ApiFallbackPoller
    ) {
        this.eventBus = EventBus.getInstance();
        this.dataStore = dataStore;
        this.fileIngestion = fileIngestion;
        this.scheduleManager = scheduleManager;
        this.apiFallbackPoller = apiFallbackPoller;

        this.setupEventListeners();
        this.initializeCityCoverage();
    }

    /**
     * Setup WebSocket server for real-time updates
     */
    public setupWebSocketServer(wss: WebSocketServer): void {
        this.wss = wss;

        wss.on('connection', (ws: WebSocket) => {
            logger.debug('[DashboardController] WebSocket client connected');
            this.clients.add(ws);

            // Send initial data
            this.sendInitialData(ws);

            ws.on('close', () => {
                logger.debug('[DashboardController] WebSocket client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                logger.error('[DashboardController] WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }

    /**
     * Send initial data to new WebSocket client
     */
    private sendInitialData(ws: WebSocket): void {
        if (ws.readyState !== WebSocket.OPEN) return;

        const initialData = {
            type: 'INITIAL_DATA',
            payload: {
                status: this.getSystemStatus(),
                models: this.getModelStatus(),
                cities: this.getCityCoverage(),
                latency: this.getLatencyMetrics(),
                apiFallback: this.getApiFallbackStatus(),
                events: this.getRecentEvents(20),
            },
        };

        ws.send(JSON.stringify(initialData));
    }

    /**
     * Broadcast update to all connected clients with throttling and deduplication
     */
    private broadcastUpdate(type: string, payload: unknown): void {
        if (!this.wss || this.clients.size === 0) return;

        // Create a key for this broadcast type
        const key = `${type}`;
        const payloadHash = JSON.stringify(payload);

        // Check if this is a duplicate of the last broadcast for this type
        const lastHash = this.lastBroadcastData.get(key);
        if (lastHash === payloadHash) {
            // Data hasn't changed, skip broadcast
            logger.debug(`[DashboardController] Skipping duplicate broadcast for ${type}`);
            return;
        }

        // Store pending broadcast
        this.pendingBroadcasts.set(key, { payload, timestamp: Date.now() });

        // Schedule batched broadcast if not already scheduled
        if (!this.broadcastTimeout) {
            this.broadcastTimeout = setTimeout(() => {
                this.flushPendingBroadcasts();
            }, this.BROADCAST_THROTTLE_MS);
        }
    }

    /**
     * Flush all pending broadcasts to clients
     */
    private flushPendingBroadcasts(): void {
        this.broadcastTimeout = null;

        if (!this.wss || this.clients.size === 0) {
            this.pendingBroadcasts.clear();
            return;
        }

        const now = Date.now();
        const messages: { type: string; payload: unknown }[] = [];

        for (const [key, { payload }] of this.pendingBroadcasts) {
            // Update last broadcast data for deduplication
            this.lastBroadcastData.set(key, JSON.stringify(payload));
            messages.push({ type: key, payload });
        }

        this.pendingBroadcasts.clear();

        // Send all messages
        for (const { type, payload } of messages) {
            const message = JSON.stringify({ type, payload });
            for (const client of this.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            }
        }

        this.lastBroadcastTime = now;
    }

    /**
     * Setup event listeners for real-time updates
     */
    private setupEventListeners(): void {
        // Listen for file detected events
        const unsubFileDetected = this.eventBus.on('FILE_DETECTED', (event) => {
            if (event.type === 'FILE_DETECTED') {
                this.handleFileDetected(event.payload);
            }
        });
        this.unsubscribers.push(unsubFileDetected);

        // Listen for file confirmed events
        const unsubFileConfirmed = this.eventBus.on('FILE_CONFIRMED', (event) => {
            if (event.type === 'FILE_CONFIRMED') {
                this.handleFileConfirmed(event.payload);
            }
        });
        this.unsubscribers.push(unsubFileConfirmed);

        // Listen for API data received events
        const unsubApiData = this.eventBus.on('API_DATA_RECEIVED', (event) => {
            if (event.type === 'API_DATA_RECEIVED') {
                this.handleApiDataReceived(event.payload);
            }
        });
        this.unsubscribers.push(unsubApiData);

        // Listen for forecast change events
        const unsubForecastChange = this.eventBus.on('FORECAST_CHANGE', (event) => {
            if (event.type === 'FORECAST_CHANGE') {
                this.handleForecastChange(event.payload);
            }
        });
        this.unsubscribers.push(unsubForecastChange);

        // Listen for detection window start events
        const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
            if (event.type === 'DETECTION_WINDOW_START') {
                this.handleDetectionWindowStart(event.payload);
            }
        });
        this.unsubscribers.push(unsubWindowStart);
    }

    /**
     * Initialize city coverage data
     */
    private initializeCityCoverage(): void {
        this.cachedCityCoverage = CITY_MODEL_CONFIGS.map((config, index) => ({
            cityId: `city-${index}`,
            cityName: config.cityName,
            primaryModel: config.primaryModel,
            lastUpdate: null,
            confirmationStatus: 'STALE',
            temperature: null,
            windSpeed: null,
            precipitation: null,
            temperatureChange: null,
            windChange: null,
            precipChange: null,
        }));
    }

    /**
     * Handle file detected event
     */
    private handleFileDetected(payload: {
        model: ModelType;
        cycleHour: number;
        detectedAt: Date;
    }): void {
        // Update model status
        this.updateModelStatus(payload.model, 'DETECTING', payload.cycleHour);

        // Add event
        this.addEvent({
            id: `evt-${Date.now()}`,
            type: 'FILE_DETECTED',
            timestamp: new Date().toISOString(),
            model: payload.model,
            message: `${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z file detected`,
            severity: 'info',
        });

        // Broadcast update
        this.broadcastUpdate('FILE_DETECTED', payload);
    }

    /**
     * Handle file confirmed event
     */
    private handleFileConfirmed(payload: {
        model: ModelType;
        cycleHour: number;
        cityData: Array<{
            cityName: string;
            temperatureF: number;
            windSpeedMph: number;
            totalPrecipitationIn: number;
        }>;
        timestamp: Date;
    }): void {
        // Update model status
        this.updateModelStatus(payload.model, 'CONFIRMED', payload.cycleHour);

        // Update city coverage
        for (const cityData of payload.cityData) {
            const city = this.cachedCityCoverage.find(
                c => c.cityName.toLowerCase() === cityData.cityName.toLowerCase()
            );
            if (city) {
                city.lastUpdate = payload.timestamp.toISOString();
                city.confirmationStatus = 'FILE_CONFIRMED';
                city.temperature = cityData.temperatureF;
                city.windSpeed = cityData.windSpeedMph;
                city.precipitation = cityData.totalPrecipitationIn;
            }
        }

        // Add event
        this.addEvent({
            id: `evt-${Date.now()}`,
            type: 'FILE_CONFIRMED',
            timestamp: new Date().toISOString(),
            model: payload.model,
            message: `${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z confirmed (${payload.cityData.length} cities)`,
            severity: 'success',
        });

        // Broadcast update
        this.broadcastUpdate('FILE_CONFIRMED', payload);
    }

    /**
     * Handle API data received event
     */
    private handleApiDataReceived(payload: {
        cityId: string;
        cityName: string;
        model: ModelType;
        temperatureF: number;
        windSpeedMph: number;
        precipitationMm: number;
        timestamp: Date;
    }): void {
        // Update city coverage
        const city = this.cachedCityCoverage.find(
            c => c.cityName.toLowerCase() === payload.cityName.toLowerCase()
        );
        if (city && city.confirmationStatus !== 'FILE_CONFIRMED') {
            city.lastUpdate = payload.timestamp.toISOString();
            city.confirmationStatus = 'API_UNCONFIRMED';
            city.temperature = payload.temperatureF;
            city.windSpeed = payload.windSpeedMph;
            city.precipitation = payload.precipitationMm / 25.4; // Convert mm to inches
        }

        // Broadcast update
        this.broadcastUpdate('API_DATA_RECEIVED', payload);
    }

    /**
     * Handle forecast change event
     */
    private handleForecastChange(payload: {
        cityId: string;
        cityName: string;
        variable: string;
        oldValue: number;
        newValue: number;
        changeAmount: number;
        confidence: string;
    }): void {
        // Update city coverage with change indicators
        const city = this.cachedCityCoverage.find(
            c => c.cityName.toLowerCase() === payload.cityName.toLowerCase()
        );
        if (city) {
            if (payload.variable === 'TEMPERATURE') {
                city.temperatureChange = payload.changeAmount;
            } else if (payload.variable === 'WIND_SPEED') {
                city.windChange = payload.changeAmount;
            } else if (payload.variable === 'PRECIPITATION') {
                city.precipChange = payload.changeAmount;
            }
        }

        // Add event
        this.addEvent({
            id: `evt-${Date.now()}`,
            type: 'FORECAST_CHANGE',
            timestamp: new Date().toISOString(),
            city: payload.cityName,
            message: `${payload.cityName}: ${payload.variable} ${payload.changeAmount > 0 ? '+' : ''}${payload.changeAmount.toFixed(1)}`,
            confidence: payload.confidence as 'HIGH' | 'LOW',
            severity: payload.confidence === 'HIGH' ? 'success' : 'warning',
        });

        // Broadcast update
        this.broadcastUpdate('FORECAST_CHANGE', payload);
    }

    /**
     * Handle detection window start event
     */
    private handleDetectionWindowStart(payload: {
        model: ModelType;
        cycleHour: number;
        windowStart: Date;
    }): void {
        // Update model status
        this.updateModelStatus(payload.model, 'DETECTING', payload.cycleHour);

        // Add event
        this.addEvent({
            id: `evt-${Date.now()}`,
            type: 'DETECTION_WINDOW_START',
            timestamp: new Date().toISOString(),
            model: payload.model,
            message: `${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z detection window started`,
            severity: 'info',
        });

        // Broadcast update
        this.broadcastUpdate('DETECTION_WINDOW_START', payload);
    }

    /**
     * Update model status
     */
    private updateModelStatus(model: ModelType, status: ModelStatus['status'], cycleHour: number): void {
        const existing = this.cachedModelStatus.find(m => m.model === model);
        if (existing) {
            existing.status = status;
            existing.cycleHour = cycleHour;
            if (status === 'CONFIRMED') {
                existing.lastRun = new Date().toISOString();
            }
        } else {
            this.cachedModelStatus.push({
                model,
                lastRun: status === 'CONFIRMED' ? new Date().toISOString() : null,
                nextExpected: null,
                status,
                progress: this.calculateProgress(status),
                cycleHour,
            });
        }
    }

    /**
     * Calculate progress percentage based on status
     */
    private calculateProgress(status: ModelStatus['status']): number {
        switch (status) {
            case 'WAITING': return 0;
            case 'DETECTING': return 50;
            case 'CONFIRMED': return 100;
            case 'TIMEOUT': return 100;
            case 'ERROR': return 0;
            default: return 0;
        }
    }

    /**
     * Add event to cache with deduplication
     */
    private addEvent(event: DashboardEvent): void {
        // Simple deduplication: Check if an identical event (same type, message, and subject) 
        // was added in the last 2 seconds.
        const DUPLICATION_WINDOW_MS = 2000;
        const now = new Date(event.timestamp).getTime();

        const isDuplicate = this.cachedEvents.some(cachedEvent => {
            const cachedTime = new Date(cachedEvent.timestamp).getTime();
            if (now - cachedTime > DUPLICATION_WINDOW_MS) return false;

            return cachedEvent.type === event.type &&
                cachedEvent.message === event.message &&
                cachedEvent.city === event.city &&
                cachedEvent.model === event.model;
        });

        if (isDuplicate) {
            logger.debug(`[DashboardController] Skipped duplicate event: ${event.type} - ${event.message}`);
            return;
        }

        this.cachedEvents.unshift(event);
        if (this.cachedEvents.length > this.MAX_CACHED_EVENTS) {
            this.cachedEvents.pop();
        }
    }

    /**
     * Get system status
     */
    public getSystemStatus(): SystemStatus {
        const isRunning = this.fileIngestion?.getIsRunning() ?? false;
        const activeWindows = this.fileIngestion?.getActiveWindows().length ?? 0;
        const lastConfirmation = this.cachedModelStatus
            .filter(m => m.lastRun)
            .sort((a, b) => new Date(b.lastRun!).getTime() - new Date(a.lastRun!).getTime())[0]?.lastRun ?? null;

        let mode: OperationalMode = 'INACTIVE';
        if (isRunning) {
            if (activeWindows > 0) {
                mode = 'BOTH';
            } else {
                mode = 'FILE_PRIMARY';
            }
        } else if (this.apiFallbackPoller) {
            mode = 'API_FALLBACK';
        }

        return {
            status: isRunning ? 'ACTIVE' : 'INACTIVE',
            mode,
            activeDetectionWindows: activeWindows,
            lastFileConfirmation: lastConfirmation,
            uptime: Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000),
            version: '3.0.0',
        };
    }

    /**
     * Get model status
     */
    public getModelStatus(): ModelStatus[] {
        const models: ModelType[] = ['HRRR', 'RAP', 'GFS', 'ECMWF'];
        const now = new Date();

        return models.map(model => {
            const cached = this.cachedModelStatus.find(m => m.model === model);
            const upcomingRuns = this.scheduleManager?.getUpcomingRuns(5) ?? [];
            const nextRun = upcomingRuns.find(r => r.model === model);

            // Get active window for this model
            const activeWindows = this.fileIngestion?.getActiveWindows() ?? [];
            const activeWindow = activeWindows.find(w => w.model === model);

            let status: ModelStatus['status'] = 'WAITING';
            let progress = 0;
            let cycleHour: number | null = null;

            if (activeWindow) {
                status = activeWindow.status === 'CONFIRMED' ? 'CONFIRMED' : 'DETECTING';
                cycleHour = activeWindow.cycleHour;

                // Calculate progress based on time in window
                const windowDuration = activeWindow.windowEnd.getTime() - activeWindow.windowStart.getTime();
                const elapsed = now.getTime() - activeWindow.windowStart.getTime();
                progress = Math.min(100, Math.round((elapsed / windowDuration) * 100));
            } else if (cached) {
                status = cached.status;
                progress = cached.progress;
                cycleHour = cached.cycleHour;
            }

            return {
                model,
                lastRun: cached?.lastRun ?? null,
                nextExpected: nextRun?.expectedPublishTime.toISOString() ?? null,
                status,
                progress,
                cycleHour,
            };
        });
    }

    /**
     * Get city coverage
     */
    public getCityCoverage(): CityCoverage[] {
        return this.cachedCityCoverage;
    }

    /**
     * Get latency metrics
     */
    public getLatencyMetrics(): LatencyMetrics {
        const stats = this.eventBus.getLatencyStats();
        return {
            ...stats,
            endToEnd: {
                ...stats.endToEnd,
                withinBudget: stats.endToEnd.last < 5000, // 5 second budget
            },
        };
    }

    /**
     * Get API fallback status
     */
    public getApiFallbackStatus(): ApiFallbackStatus {
        const eventStats = this.eventBus.getEventStats();
        const fileConfirmations = eventStats.filesConfirmed;
        const apiConfirmations = eventStats.apiDataReceived;
        const total = fileConfirmations + apiConfirmations;

        return {
            status: this.apiFallbackPoller ? 'STANDBY' : 'INACTIVE',
            activeSessions: 0, // Would need to expose from ApiFallbackPoller
            totalPollsInWindow: apiConfirmations,
            lastApiUpdate: eventStats.lastApiDataTime,
            fileConfirmations,
            apiConfirmations,
            ratio: total > 0 ? `${((fileConfirmations / total) * 100).toFixed(1)}% / ${((apiConfirmations / total) * 100).toFixed(1)}%` : 'N/A',
        };
    }

    /**
     * Get recent events
     */
    public getRecentEvents(limit: number = 50): DashboardEvent[] {
        return this.cachedEvents.slice(0, limit);
    }

    /**
     * Get active detection windows
     */
    public getActiveWindows(): DetectionWindow[] {
        return this.fileIngestion?.getActiveWindows() ?? [];
    }

    /**
     * Get upcoming model runs
     */
    public getUpcomingRuns(count: number): ReturnType<ScheduleManager['getUpcomingRuns']> {
        return this.scheduleManager?.getUpcomingRuns(count) ?? [];
    }

    /**
     * Cleanup resources
     */
    public destroy(): void {
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        this.clients.clear();
    }
}

/**
 * Create Express router for dashboard API endpoints
 */
export function createDashboardRouter(controller: DashboardController): Router {
    const router = Router();

    // GET /api/dashboard/status - Overall status
    router.get('/status', (req: Request, res: Response) => {
        res.json(controller.getSystemStatus());
    });

    // GET /api/dashboard/models - Model run status
    router.get('/models', (req: Request, res: Response) => {
        res.json(controller.getModelStatus());
    });

    // GET /api/dashboard/cities - City coverage data
    router.get('/cities', (req: Request, res: Response) => {
        res.json(controller.getCityCoverage());
    });

    // GET /api/dashboard/latency - Latency metrics
    router.get('/latency', (req: Request, res: Response) => {
        res.json(controller.getLatencyMetrics());
    });

    // GET /api/dashboard/events - Recent events
    router.get('/events', (req: Request, res: Response) => {
        const limit = parseInt(req.query.limit as string) || 50;
        res.json(controller.getRecentEvents(limit));
    });

    // GET /api/dashboard/windows - Active detection windows
    router.get('/windows', (req: Request, res: Response) => {
        res.json(controller.getActiveWindows());
    });

    // GET /api/dashboard/upcoming - Upcoming model runs
    router.get('/upcoming', (req: Request, res: Response) => {
        const count = parseInt(req.query.count as string) || 10;
        res.json(controller.getUpcomingRuns(count));
    });

    // GET /api/dashboard/api-fallback - API fallback status
    router.get('/api-fallback', (req: Request, res: Response) => {
        res.json(controller.getApiFallbackStatus());
    });

    // GET /api/dashboard/confidence - Confidence compression strategy metrics
    // (This endpoint provides useful strategy data for the dashboard)
    router.get('/confidence', (req: Request, res: Response) => {
        // Return placeholder for now - will be populated by ConfidenceCompressionStrategy
        res.json({
            totalMarketsAnalyzed: 0,
            firstRunBlocks: 0,
            stabilityBlocks: 0,
            confidenceBlocks: 0,
            signalsGenerated: 0,
            tradesExecuted: 0,
            avgConfidenceScore: 0,
            modelHierarchy: {
                us: { primary: 'HRRR', secondary: 'RAP', regime: 'GFS' },
                eu: { primary: 'ECMWF', secondary: 'GFS' },
            },
            thresholds: {
                temperature: 0.60,
                precipitation: 0.75,
            },
        });
    });

    // GET /api/dashboard/all - All dashboard data in one request
    router.get('/all', (req: Request, res: Response) => {
        res.json({
            status: controller.getSystemStatus(),
            models: controller.getModelStatus(),
            cities: controller.getCityCoverage(),
            latency: controller.getLatencyMetrics(),
            apiFallback: controller.getApiFallbackStatus(),
            events: controller.getRecentEvents(20),
            windows: controller.getActiveWindows(),
            upcoming: controller.getUpcomingRuns(5),
        });
    });

    return router;
}

