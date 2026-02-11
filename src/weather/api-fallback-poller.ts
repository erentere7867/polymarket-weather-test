/**
 * API Fallback Poller
 * Receives forecasts via EventBus from HybridWeatherController
 * Stops immediately when FILE_CONFIRMED event is received
 * Emits API_DATA_RECEIVED events with confidence: 'LOW'
 * 
 * ARCHITECTURE CHANGE: This component no longer polls independently.
 * Instead, it subscribes to FORECAST_BATCH_UPDATED events from the
 * HybridWeatherController, which is the single source of truth for
 * API polling. This eliminates redundant polling and respects rate limits.
 */

import { EventEmitter } from 'events';
import { EventBus } from '../realtime/event-bus.js';
import { logger } from '../logger.js';
import { ModelType, DetectionWindow, CityLocation, KNOWN_CITIES } from './types.js';
import { config } from '../config.js';

/**
 * API Data received event payload
 */
export interface ApiDataReceivedEvent {
    type: 'API_DATA_RECEIVED';
    payload: {
        cityId: string;
        cityName: string;
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        temperatureC: number;
        temperatureF: number;
        windSpeedMph: number;
        precipitationMm: number;
        timestamp: Date;
        confidence: 'LOW';
        source: 'API';
        status: 'UNCONFIRMED';
    };
}

/**
 * Configuration for API fallback poller
 */
export interface ApiFallbackPollerConfig {
    /** Poll interval in milliseconds during detection window */
    pollIntervalMs: number;
    /** Maximum duration of API polling in minutes */
    maxDurationMinutes: number;
    /** Whether to use cache for API calls */
    useCache: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ApiFallbackPollerConfig = {
    pollIntervalMs: 1000, // 1 second polling
    maxDurationMinutes: 5, // Max 5 minutes
    useCache: false, // Never cache during detection windows
};

/**
 * Active listening session (replaces polling session)
 */
interface ListeningSession {
    model: ModelType;
    cycleHour: number;
    windowId: string;
    startTime: Date;
    timeoutId: NodeJS.Timeout;
    isActive: boolean;
    citiesReceived: Set<string>;
    maxDurationMinutes: number;
}

/**
 * API Fallback Poller
 * Receives forecasts via EventBus instead of polling independently
 */
export class ApiFallbackPoller extends EventEmitter {
    private config: ApiFallbackPollerConfig;
    private eventBus: EventBus;
    private sessions: Map<string, ListeningSession> = new Map();
    private unsubscribers: (() => void)[] = [];

    constructor(configOverride: Partial<ApiFallbackPollerConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...configOverride };
        this.eventBus = EventBus.getInstance();
        this.setupEventListeners();
    }

    /**
     * Setup event listeners
     * DISABLED: API fallback polling disabled for file-ingestion-only mode
     */
    private setupEventListeners(): void {
        // DISABLED: API fallback polling disabled for file-ingestion-only mode
        // All event listeners commented out - file-based ingestion is the primary data source
        logger.info('[ApiFallbackPoller] API fallback polling disabled - file-ingestion-only mode');
        
        // DISABLED: Event listeners commented out
        // // Listen for FILE_CONFIRMED to stop listening immediately
        // const unsubConfirmed = this.eventBus.on('FILE_CONFIRMED', (event) => {
        //     if (event.type === 'FILE_CONFIRMED') {
        //         const { model, cycleHour } = event.payload;
        //         this.handleFileConfirmed(model, cycleHour);
        //     }
        // });
        // this.unsubscribers.push(unsubConfirmed);
        // 
        // // Listen for DETECTION_WINDOW_START to begin listening mode
        // const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
        //     if (event.type === 'DETECTION_WINDOW_START') {
        //         const { model, cycleHour, windowStart } = event.payload;
        //         this.startListening(model, cycleHour, windowStart);
        //     }
        // });
        // this.unsubscribers.push(unsubWindowStart);
        // 
        // // Listen for FORECAST_BATCH_UPDATED events from HybridWeatherController
        // const unsubBatchUpdate = this.eventBus.on('FORECAST_BATCH_UPDATED', (event) => {
        //     if (event.type === 'FORECAST_BATCH_UPDATED') {
        //         this.handleForecastBatchUpdate(event.payload);
        //     }
        // });
        // this.unsubscribers.push(unsubBatchUpdate);
        // 
        // // Listen for RATE_LIMIT_HIT events
        // const unsubRateLimit = this.eventBus.on('RATE_LIMIT_HIT', (event) => {
        //     if (event.type === 'RATE_LIMIT_HIT') {
        //         logger.warn(`[ApiFallbackPoller] Rate limit hit for ${event.payload.provider}: ${event.payload.message}`);
        //     }
        // });
        // this.unsubscribers.push(unsubRateLimit);
    }

    /**
     * Start listening for a detection window (replaces polling)
     * DISABLED: API fallback polling disabled for file-ingestion-only mode
     */
    public startListening(
        model: ModelType,
        cycleHour: number,
        windowStart: Date
    ): void {
        // DISABLED: API fallback polling disabled for file-ingestion-only mode
        logger.debug(`[ApiFallbackPoller] startListening disabled for file-ingestion-only mode (${model} ${String(cycleHour).padStart(2, '0')}Z)`);
        return;
        
        // DISABLED: Listening logic commented out
        // const windowId = this.getWindowId(model, cycleHour);
        // 
        // // Don't start if already listening for this window
        // if (this.sessions.has(windowId)) {
        //     logger.debug(`[ApiFallbackPoller] Already listening for ${windowId}`);
        //     return;
        // }
        // 
        // logger.info(
        //     `[ApiFallbackPoller] Starting API listening for ${model} ${String(cycleHour).padStart(2, '0')}Z (via EventBus)`
        // );
        // 
        // // Create session
        // const session: ListeningSession = {
        //     model,
        //     cycleHour,
        //     windowId,
        //     startTime: new Date(),
        //     timeoutId: null as unknown as NodeJS.Timeout,
        //     isActive: true,
        //     citiesReceived: new Set(),
        //     maxDurationMinutes: this.config.maxDurationMinutes,
        // };
        // 
        // // Set timeout to stop after max duration
        // const maxDurationMs = this.config.maxDurationMinutes * 60 * 1000;
        // session.timeoutId = setTimeout(() => {
        //     logger.info(
        //         `[ApiFallbackPoller] Max duration reached for ${windowId}, stopping`
        //     );
        //     this.stopListening(windowId);
        // }, maxDurationMs);
        // 
        // this.sessions.set(windowId, session);
        // 
        // this.emit('listeningStarted', {
        //     model,
        //     cycleHour,
        //     windowId,
        //     maxDurationMinutes: this.config.maxDurationMinutes,
        // });
    }

    /**
     * Handle forecast batch update from HybridWeatherController
     */
    private handleForecastBatchUpdate(payload: {
        forecasts: Array<{
            cityId: string;
            cityName: string;
            temperatureC: number;
            temperatureF: number;
            windSpeedMph: number;
            precipitationMm: number;
            timestamp: Date;
        }>;
        provider: string;
        batchTimestamp: Date;
        totalCities: number;
    }): void {
        // Process forecasts for all active sessions
        for (const session of this.sessions.values()) {
            if (!session.isActive) continue;

            for (const forecast of payload.forecasts) {
                const cityId = forecast.cityId;

                // Track received cities
                session.citiesReceived.add(cityId);

                // Emit API_DATA_RECEIVED event
                const event: ApiDataReceivedEvent = {
                    type: 'API_DATA_RECEIVED',
                    payload: {
                        cityId,
                        cityName: forecast.cityName,
                        model: session.model,
                        cycleHour: session.cycleHour,
                        forecastHour: 0, // f00 equivalent
                        temperatureC: forecast.temperatureC,
                        temperatureF: forecast.temperatureF,
                        windSpeedMph: forecast.windSpeedMph,
                        precipitationMm: forecast.precipitationMm,
                        timestamp: forecast.timestamp,
                        confidence: 'LOW',
                        source: 'API',
                        status: 'UNCONFIRMED',
                    },
                };

                this.eventBus.emit(event);
                this.emit('apiDataReceived', event.payload);
            }

            logger.debug(
                `[ApiFallbackPoller] Received batch update for ${session.windowId}: ${payload.forecasts.length} cities from ${payload.provider}`
            );
        }
    }

    /**
     * Handle FILE_CONFIRMED event - stop listening immediately
     */
    private handleFileConfirmed(model: ModelType, cycleHour: number): void {
        const windowId = this.getWindowId(model, cycleHour);

        if (this.sessions.has(windowId)) {
            logger.info(
                `[ApiFallbackPoller] FILE_CONFIRMED received, stopping listening for ${windowId}`
            );
            this.stopListening(windowId);
        }
    }

    /**
     * Stop listening for a specific window
     */
    public stopListening(windowId: string): void {
        const session = this.sessions.get(windowId);
        if (!session) return;

        session.isActive = false;

        // Clear timeout
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
        }

        const durationMs = Date.now() - session.startTime.getTime();

        logger.info(
            `[ApiFallbackPoller] Stopped listening for ${windowId} ` +
            `(duration: ${(durationMs / 1000).toFixed(1)}s, cities: ${session.citiesReceived.size})`
        );

        this.emit('listeningStopped', {
            windowId,
            model: session.model,
            cycleHour: session.cycleHour,
            durationMs,
            citiesReceived: session.citiesReceived.size,
        });

        this.sessions.delete(windowId);
    }

    /**
     * Stop all listening sessions
     */
    public stopAll(): void {
        logger.info(
            `[ApiFallbackPoller] Stopping all listening sessions (${this.sessions.size} active)`
        );

        for (const windowId of this.sessions.keys()) {
            this.stopListening(windowId);
        }
    }

    /**
     * Get active session count
     */
    public getActiveSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Get active sessions
     */
    public getActiveSessions(): Array<{
        windowId: string;
        model: ModelType;
        cycleHour: number;
        startTime: Date;
        durationMs: number;
        citiesReceived: number;
    }> {
        return Array.from(this.sessions.values()).map((session) => ({
            windowId: session.windowId,
            model: session.model,
            cycleHour: session.cycleHour,
            startTime: session.startTime,
            durationMs: Date.now() - session.startTime.getTime(),
            citiesReceived: session.citiesReceived.size,
        }));
    }

    /**
     * Legacy method name for backward compatibility
     * @deprecated Use startListening instead
     */
    public startPolling(
        model: ModelType,
        cycleHour: number,
        windowStart: Date
    ): void {
        this.startListening(model, cycleHour, windowStart);
    }

    /**
     * Legacy method name for backward compatibility
     * @deprecated Use stopListening instead
     */
    public stopPolling(windowId: string): void {
        this.stopListening(windowId);
    }

    /**
     * Dispose of the poller
     */
    public dispose(): void {
        this.stopAll();

        // Unsubscribe from events
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
    }

    /**
     * Generate window ID
     */
    private getWindowId(model: ModelType, cycleHour: number): string {
        const dateStr = new Date().toISOString().split('T')[0];
        return `${model}-${dateStr}-${String(cycleHour).padStart(2, '0')}Z`;
    }
}

export default ApiFallbackPoller;
