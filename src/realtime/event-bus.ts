/**
 * Event Bus
 * Simple event bus for internal communication between components
 * Supports typed events and callbacks
 */

import { Coordinates, FileDetectedData, FileConfirmedData, DetectionWindow, ModelType } from '../weather/types.js';
import { logger } from '../logger.js';
import { LatencyTracker } from './latency-tracker.js';

// Event type definitions
export type EventType =
    | 'FORECAST_TRIGGER'
    | 'FETCH_MODE_ENTER'
    | 'FETCH_MODE_EXIT'
    | 'PROVIDER_FETCH'
    | 'FORECAST_CHANGED'
    | 'FILE_DETECTED'
    | 'FILE_CONFIRMED'
    | 'DETECTION_WINDOW_START'
    | 'API_DATA_RECEIVED'
    | 'FORECAST_CHANGE'
    | 'FORECAST_UPDATED'
    | 'FORECAST_BATCH_UPDATED'
    | 'RATE_LIMIT_HIT'
    | 'EARLY_TRIGGER_MODE'
    | 'RAP_CONFIRMED'
    | 'RAP_HRRR_CONFIRMED';

// Event payload interfaces
export interface ForecastTriggerEvent {
    type: 'FORECAST_TRIGGER';
    payload: {
        provider: 'tomorrow.io';
        cityId: string;
        triggerTimestamp: Date;
        location: Coordinates;
        forecastId?: string;
        updateType?: string;
    };
}

export interface FetchModeEnterEvent {
    type: 'FETCH_MODE_ENTER';
    payload: {
        cityId: string;
        timestamp: Date;
        reason: 'webhook' | 'manual' | 'fallback';
    };
}

export interface FetchModeExitEvent {
    type: 'FETCH_MODE_EXIT';
    payload: {
        cityId: string;
        timestamp: Date;
        reason: 'no_changes' | 'timeout' | 'manual';
    };
}

export interface ProviderFetchEvent {
    type: 'PROVIDER_FETCH';
    payload: {
        cityId: string;
        provider: string;
        success: boolean;
        hasChanges: boolean;
        error?: string;
    };
}

export interface ForecastChangedEvent {
    type: 'FORECAST_CHANGED';
    payload: {
        cityId: string;
        marketId?: string;
        provider: string;
        previousValue?: number;
        newValue: number;
        changeAmount: number;
        timestamp: Date;
    };
}

export interface FileDetectedEvent {
    type: 'FILE_DETECTED';
    payload: {
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        bucket: string;
        key: string;
        detectedAt: Date;
        detectionLatencyMs: number;
        fileSize: number;
        lastModified: Date;
        traceId?: string;  // Unique ID for end-to-end latency tracking
    };
}

export interface FileConfirmedEvent {
    type: 'FILE_CONFIRMED';
    payload: {
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        cityData: FileConfirmedData['cityData'];
        timestamp: Date;
        source: 'FILE';
        detectionLatencyMs: number;
        downloadTimeMs: number;
        parseTimeMs: number;
        fileSize: number;
        traceId?: string;  // Unique ID for end-to-end latency tracking
    };
}

export interface DetectionWindowStartEvent {
    type: 'DETECTION_WINDOW_START';
    payload: {
        model: ModelType;
        cycleHour: number;
        runDate: Date;
        windowStart: Date;
        expectedFile: {
            bucket: string;
            key: string;
            fullUrl: string;
        };
    };
}

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

export interface ForecastChangeEvent {
    type: 'FORECAST_CHANGE';
    payload: {
        cityId: string;
        cityName: string;
        variable: 'TEMPERATURE' | 'WIND_SPEED' | 'PRECIPITATION';
        oldValue: number;
        newValue: number;
        changeAmount: number;
        changePercent: number;
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        timestamp: Date;
        source: 'FILE' | 'API';
        confidence: 'HIGH' | 'LOW';
        threshold: number;
        thresholdExceeded: boolean;
    };
}

export interface ForecastUpdatedEvent {
    type: 'FORECAST_UPDATED';
    payload: {
        cityId: string;
        cityName: string;
        provider: string;
        temperatureC: number;
        temperatureF: number;
        windSpeedMph: number;
        precipitationMm: number;
        timestamp: Date;
        source: 'API' | 'CACHE' | 'FILE' | 'S3_FILE' | 'WEBHOOK';
        confidence?: number;
    };
}

export interface ForecastBatchUpdatedEvent {
    type: 'FORECAST_BATCH_UPDATED';
    payload: {
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
    };
}

export interface RateLimitHitEvent {
    type: 'RATE_LIMIT_HIT';
    payload: {
        provider: string;
        timestamp: Date;
        retryAfterMs?: number;
        message: string;
    };
}

export interface EarlyTriggerModeEvent {
    type: 'EARLY_TRIGGER_MODE';
    payload: {
        model: string;
        cycleHour: number;
        minutesUntilExpected: number;
        aggressivePollIntervalMs: number;
    };
}

export interface RapConfirmedEvent {
    type: 'RAP_CONFIRMED';
    payload: {
        cycleHour: number;
        runDate: Date;
        confirmedAt: Date;
    };
}

export interface RapHrrrConfirmedEvent {
    type: 'RAP_HRRR_CONFIRMED';
    payload: {
        cycleHour: number;
        runDate: string; // YYYY-MM-DD
        confirmedAt: Date;
        confirmedCities: string[]; // cityIds that have confirmed data
        temperatureDifferences: Map<string, number>; // cityId -> temp difference (°F)
    };
}

// Union type of all events
export type Event =
    | ForecastTriggerEvent
    | FetchModeEnterEvent
    | FetchModeExitEvent
    | ProviderFetchEvent
    | ForecastChangedEvent
    | FileDetectedEvent
    | FileConfirmedEvent
    | DetectionWindowStartEvent
    | ApiDataReceivedEvent
    | ForecastChangeEvent
    | ForecastUpdatedEvent
    | ForecastBatchUpdatedEvent
    | RateLimitHitEvent
    | EarlyTriggerModeEvent
    | RapConfirmedEvent
    | RapHrrrConfirmedEvent;

// Event handler type
export type EventHandler<T extends Event> = (event: T) => void | Promise<void>;

/**
 * Simple Event Bus for internal communication
 */
export class EventBus {
    private handlers: Map<EventType, Set<EventHandler<any>>> = new Map();
    private static instance: EventBus | null = null;

    /**
     * Get singleton instance
     */
    public static getInstance(): EventBus {
        if (!EventBus.instance) {
            EventBus.instance = new EventBus();
        }
        return EventBus.instance;
    }

    /**
     * Reset singleton instance (useful for testing)
     */
    public static resetInstance(): void {
        EventBus.instance = null;
    }

    private constructor() {
        // Initialize handler sets for each event type
        const eventTypes: EventType[] = [
            'FORECAST_TRIGGER',
            'FETCH_MODE_ENTER',
            'FETCH_MODE_EXIT',
            'PROVIDER_FETCH',
            'FORECAST_CHANGED',
            'FILE_DETECTED',
            'FILE_CONFIRMED',
            'DETECTION_WINDOW_START',
            'API_DATA_RECEIVED',
            'FORECAST_CHANGE',
            'FORECAST_UPDATED',
            'FORECAST_BATCH_UPDATED',
            'RATE_LIMIT_HIT',
            'EARLY_TRIGGER_MODE',
            'RAP_CONFIRMED',
            'RAP_HRRR_CONFIRMED',
        ];
        for (const type of eventTypes) {
            this.handlers.set(type, new Set());
        }
    }

    /**
     * Subscribe to an event type
     * @returns Unsubscribe function
     */
    public on<T extends Event>(
        eventType: T['type'],
        handler: EventHandler<T>
    ): () => void {
        const handlers = this.handlers.get(eventType);
        if (!handlers) {
            throw new Error(`Unknown event type: ${eventType}`);
        }

        handlers.add(handler);

        // Return unsubscribe function
        return () => {
            handlers.delete(handler);
        };
    }

    /**
     * Subscribe to an event type for one-time execution
     */
    public once<T extends Event>(
        eventType: T['type'],
        handler: EventHandler<T>
    ): void {
        const unsubscribe = this.on(eventType, (event: T) => {
            unsubscribe();
            handler(event);
        });
    }

    /**
     * Emit an event to all subscribers
     * OPTIMIZED: Uses setImmediate for non-blocking dispatch of async handlers
     */
    public emit<T extends Event>(event: T): void {
        const handlers = this.handlers.get(event.type);
        if (!handlers || handlers.size === 0) {
            return;
        }

        // Track event for dashboard (fast path)
        this.trackEventForDashboard(event);

        // Track latency for events with traceId
        this.trackEventLatency(event);

        // Convert handlers to array for faster iteration
        const handlerArray = Array.from(handlers);
        
        // Execute handlers - sync handlers immediately, async handlers via setImmediate
        for (let i = 0; i < handlerArray.length; i++) {
            const handler = handlerArray[i];
            try {
                const result = handler(event);
                if (result instanceof Promise) {
                    // Offload async handlers to next tick to prevent blocking
                    setImmediate(() => {
                        result.catch((err: Error) => {
                            logger.error(`Error in async event handler for ${event.type}`, { error: err.message, stack: err.stack });
                        });
                    });
                }
            } catch (err) {
                const error = err as Error;
                logger.error(`Error in event handler for ${event.type}`, { error: error.message, stack: error.stack });
            }
        }
    }

    /**
     * Track latency for events with traceId
     */
    private trackEventLatency<T extends Event>(event: T): void {
        const latencyTracker = LatencyTracker.getInstance();
        
        // Record eventEmitTime for events with traceId
        if (event.type === 'FILE_DETECTED' && (event.payload as any).traceId) {
            latencyTracker.recordTime((event.payload as any).traceId, 'eventEmitTime', Date.now());
        } else if (event.type === 'FILE_CONFIRMED' && (event.payload as any).traceId) {
            latencyTracker.recordTime((event.payload as any).traceId, 'eventEmitTime', Date.now());
        }
    }

    /**
     * Track events for dashboard statistics
     */
    private trackEventForDashboard<T extends Event>(event: T): void {
        switch (event.type) {
            case 'FILE_DETECTED':
                this.recordFileDetected(
                    event.payload.model,
                    event.payload.cycleHour,
                    event.payload.detectionLatencyMs
                );
                break;
            case 'FILE_CONFIRMED':
                this.recordFileConfirmed(
                    event.payload.model,
                    event.payload.cycleHour,
                    event.payload.detectionLatencyMs,
                    event.payload.downloadTimeMs,
                    event.payload.parseTimeMs,
                    event.payload.cityData.length
                );
                break;
            case 'API_DATA_RECEIVED':
                this.recordApiDataReceived(
                    event.payload.cityId,
                    event.payload.model
                );
                break;
            case 'FORECAST_CHANGE':
                this.recordForecastChange(
                    event.payload.cityId,
                    event.payload.variable,
                    event.payload.oldValue,
                    event.payload.newValue,
                    event.payload.confidence
                );
                break;
        }
    }

    /**
     * Remove all handlers for an event type
     */
    public off(eventType: EventType): void {
        const handlers = this.handlers.get(eventType);
        if (handlers) {
            handlers.clear();
        }
    }

    /**
     * Get the number of handlers for an event type
     */
    public handlerCount(eventType: EventType): number {
        return this.handlers.get(eventType)?.size ?? 0;
    }

    // Event statistics tracking
    private eventStats: {
        webhooksReceived: number;
        webhooksProcessed: number;
        fetchCyclesCompleted: number;
        lastWebhookTime: Date | null;
        lastTriggerTime: Date | null;
        filesDetected: number;
        filesConfirmed: number;
        apiDataReceived: number;
        forecastChanges: number;
        lastFileDetectedTime: Date | null;
        lastFileConfirmedTime: Date | null;
        lastApiDataTime: Date | null;
        lastForecastChangeTime: Date | null;
    } = {
        webhooksReceived: 0,
        webhooksProcessed: 0,
        fetchCyclesCompleted: 0,
        lastWebhookTime: null,
        lastTriggerTime: null,
        filesDetected: 0,
        filesConfirmed: 0,
        apiDataReceived: 0,
        forecastChanges: 0,
        lastFileDetectedTime: null,
        lastFileConfirmedTime: null,
        lastApiDataTime: null,
        lastForecastChangeTime: null,
    };

    // Latency tracking for dashboard metrics
    private latencyStats: {
        detectionLatencies: number[];
        downloadLatencies: number[];
        parseLatencies: number[];
        endToEndLatencies: number[];
        maxSamples: number;
    } = {
        detectionLatencies: [],
        downloadLatencies: [],
        parseLatencies: [],
        endToEndLatencies: [],
        maxSamples: 100,
    };

    // Recent events buffer for dashboard event log
    private recentEvents: Array<{
        type: EventType;
        timestamp: Date;
        data: Record<string, unknown>;
    }> = [];
    private readonly MAX_RECENT_EVENTS = 100;

    /**
     * Record a webhook received event
     */
    public recordWebhookReceived(): void {
        this.eventStats.webhooksReceived++;
        this.eventStats.lastWebhookTime = new Date();
    }

    /**
     * Record a webhook processed event
     */
    public recordWebhookProcessed(): void {
        this.eventStats.webhooksProcessed++;
    }

    /**
     * Record a fetch cycle completion
     */
    public recordFetchCycleCompleted(): void {
        this.eventStats.fetchCyclesCompleted++;
    }

    /**
     * Record a forecast trigger event
     */
    public recordTrigger(): void {
        this.eventStats.lastTriggerTime = new Date();
    }

    /**
     * Record file detected event
     */
    public recordFileDetected(model: ModelType, cycleHour: number, latencyMs: number): void {
        this.eventStats.filesDetected++;
        this.eventStats.lastFileDetectedTime = new Date();
        this.addLatencySample('detection', latencyMs);
        this.addRecentEvent('FILE_DETECTED', { model, cycleHour, latencyMs });
    }

    /**
     * Record file confirmed event
     */
    public recordFileConfirmed(
        model: ModelType,
        cycleHour: number,
        detectionLatencyMs: number,
        downloadTimeMs: number,
        parseTimeMs: number,
        cityCount: number
    ): void {
        this.eventStats.filesConfirmed++;
        this.eventStats.lastFileConfirmedTime = new Date();
        this.addLatencySample('detection', detectionLatencyMs);
        this.addLatencySample('download', downloadTimeMs);
        this.addLatencySample('parse', parseTimeMs);
        this.addLatencySample('endToEnd', detectionLatencyMs + downloadTimeMs + parseTimeMs);
        this.addRecentEvent('FILE_CONFIRMED', { model, cycleHour, cityCount });
    }

    /**
     * Record API data received event
     */
    public recordApiDataReceived(cityId: string, model: ModelType): void {
        this.eventStats.apiDataReceived++;
        this.eventStats.lastApiDataTime = new Date();
        this.addRecentEvent('API_DATA_RECEIVED', { cityId, model });
    }

    /**
     * Record forecast change event
     */
    public recordForecastChange(
        cityId: string,
        variable: string,
        oldValue: number,
        newValue: number,
        confidence: string
    ): void {
        this.eventStats.forecastChanges++;
        this.eventStats.lastForecastChangeTime = new Date();
        this.addRecentEvent('FORECAST_CHANGE', {
            cityId,
            variable,
            oldValue,
            newValue,
            changeAmount: newValue - oldValue,
            confidence,
        });
    }

    /**
     * Add a latency sample
     */
    private addLatencySample(type: 'detection' | 'download' | 'parse' | 'endToEnd', latencyMs: number): void {
        const arr = type === 'detection' ? this.latencyStats.detectionLatencies :
                    type === 'download' ? this.latencyStats.downloadLatencies :
                    type === 'parse' ? this.latencyStats.parseLatencies :
                    this.latencyStats.endToEndLatencies;
        
        arr.push(latencyMs);
        
        // Keep only the most recent samples
        if (arr.length > this.latencyStats.maxSamples) {
            arr.shift();
        }
    }

    /**
     * Add a recent event to the buffer
     */
    private addRecentEvent(type: EventType, data: Record<string, unknown>): void {
        this.recentEvents.push({
            type,
            timestamp: new Date(),
            data,
        });
        
        // Keep only the most recent events
        if (this.recentEvents.length > this.MAX_RECENT_EVENTS) {
            this.recentEvents.shift();
        }
    }

    /**
     * Calculate average of an array
     */
    private calculateAverage(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    /**
     * Calculate p95 of an array
     */
    private calculateP95(arr: number[]): number {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil(sorted.length * 0.95) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * Get event statistics for dashboard
     */
    public getEventStats(): {
        webhooksReceived: number;
        webhooksProcessed: number;
        fetchCyclesCompleted: number;
        lastWebhookTime: string | null;
        lastTriggerTime: string | null;
        filesDetected: number;
        filesConfirmed: number;
        apiDataReceived: number;
        forecastChanges: number;
        lastFileDetectedTime: string | null;
        lastFileConfirmedTime: string | null;
        lastApiDataTime: string | null;
        lastForecastChangeTime: string | null;
    } {
        return {
            webhooksReceived: this.eventStats.webhooksReceived,
            webhooksProcessed: this.eventStats.webhooksProcessed,
            fetchCyclesCompleted: this.eventStats.fetchCyclesCompleted,
            lastWebhookTime: this.eventStats.lastWebhookTime?.toISOString() || null,
            lastTriggerTime: this.eventStats.lastTriggerTime?.toISOString() || null,
            filesDetected: this.eventStats.filesDetected,
            filesConfirmed: this.eventStats.filesConfirmed,
            apiDataReceived: this.eventStats.apiDataReceived,
            forecastChanges: this.eventStats.forecastChanges,
            lastFileDetectedTime: this.eventStats.lastFileDetectedTime?.toISOString() || null,
            lastFileConfirmedTime: this.eventStats.lastFileConfirmedTime?.toISOString() || null,
            lastApiDataTime: this.eventStats.lastApiDataTime?.toISOString() || null,
            lastForecastChangeTime: this.eventStats.lastForecastChangeTime?.toISOString() || null,
        };
    }

    /**
     * Get latency statistics for dashboard
     */
    public getLatencyStats(): {
        detection: { last: number; average: number; p95: number; count: number };
        download: { last: number; average: number; p95: number; count: number };
        parse: { last: number; average: number; p95: number; count: number };
        endToEnd: { last: number; average: number; p95: number; count: number };
    } {
        return {
            detection: {
                last: this.latencyStats.detectionLatencies[this.latencyStats.detectionLatencies.length - 1] || 0,
                average: Math.round(this.calculateAverage(this.latencyStats.detectionLatencies)),
                p95: Math.round(this.calculateP95(this.latencyStats.detectionLatencies)),
                count: this.latencyStats.detectionLatencies.length,
            },
            download: {
                last: this.latencyStats.downloadLatencies[this.latencyStats.downloadLatencies.length - 1] || 0,
                average: Math.round(this.calculateAverage(this.latencyStats.downloadLatencies)),
                p95: Math.round(this.calculateP95(this.latencyStats.downloadLatencies)),
                count: this.latencyStats.downloadLatencies.length,
            },
            parse: {
                last: this.latencyStats.parseLatencies[this.latencyStats.parseLatencies.length - 1] || 0,
                average: Math.round(this.calculateAverage(this.latencyStats.parseLatencies)),
                p95: Math.round(this.calculateP95(this.latencyStats.parseLatencies)),
                count: this.latencyStats.parseLatencies.length,
            },
            endToEnd: {
                last: this.latencyStats.endToEndLatencies[this.latencyStats.endToEndLatencies.length - 1] || 0,
                average: Math.round(this.calculateAverage(this.latencyStats.endToEndLatencies)),
                p95: Math.round(this.calculateP95(this.latencyStats.endToEndLatencies)),
                count: this.latencyStats.endToEndLatencies.length,
            },
        };
    }

    /**
     * Get recent events for dashboard event log
     */
    public getRecentEvents(limit: number = 50): Array<{
        type: EventType;
        timestamp: string;
        data: Record<string, unknown>;
    }> {
        return this.recentEvents
            .slice(-limit)
            .reverse()
            .map(e => ({
                type: e.type,
                timestamp: e.timestamp.toISOString(),
                data: e.data,
            }));
    }
}

// Export singleton instance for convenience
export const eventBus = EventBus.getInstance();
