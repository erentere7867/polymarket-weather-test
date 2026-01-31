/**
 * Event Bus
 * Simple event bus for internal communication between components
 * Supports typed events and callbacks
 */

import { Coordinates } from '../weather/types.js';

// Event type definitions
export type EventType =
    | 'FORECAST_TRIGGER'
    | 'FETCH_MODE_ENTER'
    | 'FETCH_MODE_EXIT'
    | 'PROVIDER_FETCH'
    | 'FORECAST_CHANGED';

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

// Union type of all events
export type Event =
    | ForecastTriggerEvent
    | FetchModeEnterEvent
    | FetchModeExitEvent
    | ProviderFetchEvent
    | ForecastChangedEvent;

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
     */
    public emit<T extends Event>(event: T): void {
        const handlers = this.handlers.get(event.type);
        if (!handlers) {
            console.warn(`No handlers registered for event type: ${event.type}`);
            return;
        }

        // Execute all handlers asynchronously
        for (const handler of handlers) {
            try {
                const result = handler(event);
                if (result instanceof Promise) {
                    result.catch((err) => {
                        console.error(`Error in async event handler for ${event.type}:`, err);
                    });
                }
            } catch (err) {
                console.error(`Error in event handler for ${event.type}:`, err);
            }
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
    } = {
        webhooksReceived: 0,
        webhooksProcessed: 0,
        fetchCyclesCompleted: 0,
        lastWebhookTime: null,
        lastTriggerTime: null,
    };

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
     * Get event statistics for dashboard
     */
    public getEventStats(): {
        webhooksReceived: number;
        webhooksProcessed: number;
        fetchCyclesCompleted: number;
        lastWebhookTime: string | null;
        lastTriggerTime: string | null;
    } {
        return {
            webhooksReceived: this.eventStats.webhooksReceived,
            webhooksProcessed: this.eventStats.webhooksProcessed,
            fetchCyclesCompleted: this.eventStats.fetchCyclesCompleted,
            lastWebhookTime: this.eventStats.lastWebhookTime?.toISOString() || null,
            lastTriggerTime: this.eventStats.lastTriggerTime?.toISOString() || null,
        };
    }
}

// Export singleton instance for convenience
export const eventBus = EventBus.getInstance();
