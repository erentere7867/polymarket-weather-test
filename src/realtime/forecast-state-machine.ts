/**
 * Forecast State Machine
 * Manages IDLE ↔ FETCH_MODE transitions for each city
 */

import { EventEmitter } from 'events';
import { eventBus } from './event-bus.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * State machine states
 */
export type CityState = 'IDLE' | 'FETCH_MODE';

/**
 * Provider status tracking
 */
export interface ProviderStatus {
    name: string;
    lastFetchTime: Date | null;
    lastError: Date | null;
    consecutiveErrors: number;
    isActive: boolean;
}

/**
 * State context for each city
 */
export interface StateContext {
    cityId: string;
    state: CityState;
    fetchModeEntryTime: Date | null;
    lastForecastChange: Date | null;
    lastProviderFetch: Map<string, Date>;
    providerErrorCounts: Map<string, number>;
    processedWebhookIds: Set<string>;
    exitTimeoutId: NodeJS.Timeout | null;
    noChangeTimeoutId: NodeJS.Timeout | null;
}

/**
 * State transition event
 */
export interface StateTransition {
    from: CityState;
    to: CityState;
    cityId: string;
    timestamp: Date;
    reason: string;
}

/**
 * Forecast State Machine
 * Manages per-city state transitions between IDLE and FETCH_MODE
 */
export class ForecastStateMachine extends EventEmitter {
    private cityStates: Map<string, StateContext> = new Map();
    private readonly fetchModeTimeoutMs: number;
    private readonly noChangeExitMs: number;

    constructor() {
        super();
        this.fetchModeTimeoutMs = (config.FETCH_MODE_TIMEOUT_MINUTES || 10) * 60 * 1000;
        this.noChangeExitMs = (config.NO_CHANGE_EXIT_MINUTES || 5) * 60 * 1000;

        logger.info('ForecastStateMachine initialized', {
            fetchModeTimeoutMinutes: this.fetchModeTimeoutMs / 60000,
            noChangeExitMinutes: this.noChangeExitMs / 60000,
        });
    }

    /**
     * Get or create state context for a city
     */
    private getOrCreateContext(cityId: string): StateContext {
        let context = this.cityStates.get(cityId);
        if (!context) {
            context = {
                cityId,
                state: 'IDLE',
                fetchModeEntryTime: null,
                lastForecastChange: null,
                lastProviderFetch: new Map(),
                providerErrorCounts: new Map(),
                processedWebhookIds: new Set(),
                exitTimeoutId: null,
                noChangeTimeoutId: null,
            };
            this.cityStates.set(cityId, context);
        }
        return context;
    }

    /**
     * Get current state for a city
     */
    getState(cityId: string): CityState {
        return this.getOrCreateContext(cityId).state;
    }

    /**
     * Get full context for a city
     */
    getContext(cityId: string): StateContext {
        return this.getOrCreateContext(cityId);
    }

    /**
     * Check if a city is in FETCH_MODE
     */
    isInFetchMode(cityId: string): boolean {
        return this.getState(cityId) === 'FETCH_MODE';
    }

    /**
     * Check if a city is in IDLE state
     */
    isIdle(cityId: string): boolean {
        return this.getState(cityId) === 'IDLE';
    }

    /**
     * Enter FETCH_MODE for a city
     */
    enterFetchMode(cityId: string, reason: 'webhook' | 'manual' | 'fallback' = 'webhook'): boolean {
        const context = this.getOrCreateContext(cityId);

        // Already in FETCH_MODE - reset timeouts but don't transition
        if (context.state === 'FETCH_MODE') {
            logger.debug(`City ${cityId} already in FETCH_MODE, resetting timeouts`);
            this.resetTimeouts(context);
            this.setupTimeouts(context);
            return false;
        }

        // Perform state transition
        const previousState = context.state;
        context.state = 'FETCH_MODE';
        context.fetchModeEntryTime = new Date();

        // Clear any existing timeouts
        this.clearTimeouts(context);

        // Setup new timeouts
        this.setupTimeouts(context);

        // Emit transition event
        const transition: StateTransition = {
            from: previousState,
            to: 'FETCH_MODE',
            cityId,
            timestamp: new Date(),
            reason,
        };

        this.emit('transition', transition);
        this.emit(`enterFetchMode:${cityId}`, transition);

        // Emit event via event bus
        eventBus.emit({
            type: 'FETCH_MODE_ENTER',
            payload: {
                cityId,
                timestamp: new Date(),
                reason,
            },
        });

        logger.info(`🔄 State transition: ${previousState} → FETCH_MODE for ${cityId}`, { reason });

        return true;
    }

    /**
     * Exit FETCH_MODE and return to IDLE
     */
    exitFetchMode(cityId: string, reason: 'no_changes' | 'timeout' | 'manual' = 'manual'): boolean {
        const context = this.getOrCreateContext(cityId);

        // Already in IDLE
        if (context.state === 'IDLE') {
            return false;
        }

        // Perform state transition
        const previousState = context.state;
        context.state = 'IDLE';
        context.fetchModeEntryTime = null;

        // Clear all timeouts
        this.clearTimeouts(context);

        // Emit transition event
        const transition: StateTransition = {
            from: previousState,
            to: 'IDLE',
            cityId,
            timestamp: new Date(),
            reason,
        };

        this.emit('transition', transition);
        this.emit(`exitFetchMode:${cityId}`, transition);

        // Emit event via event bus
        eventBus.emit({
            type: 'FETCH_MODE_EXIT',
            payload: {
                cityId,
                timestamp: new Date(),
                reason,
            },
        });

        logger.info(`🔄 State transition: ${previousState} → IDLE for ${cityId}`, { reason });

        return true;
    }

    /**
     * Setup timeouts for FETCH_MODE
     */
    private setupTimeouts(context: StateContext): void {
        // Hard timeout - always exit after max duration
        context.exitTimeoutId = setTimeout(() => {
            logger.info(`⏰ Hard timeout reached for ${context.cityId}`);
            this.exitFetchMode(context.cityId, 'timeout');
        }, this.fetchModeTimeoutMs);

        // No-change timeout - exit if no forecast changes
        this.resetNoChangeTimeout(context);
    }

    /**
     * Clear all timeouts for a context
     */
    private clearTimeouts(context: StateContext): void {
        if (context.exitTimeoutId) {
            clearTimeout(context.exitTimeoutId);
            context.exitTimeoutId = null;
        }
        if (context.noChangeTimeoutId) {
            clearTimeout(context.noChangeTimeoutId);
            context.noChangeTimeoutId = null;
        }
    }

    /**
     * Reset timeouts (for when FETCH_MODE is extended)
     */
    private resetTimeouts(context: StateContext): void {
        this.clearTimeouts(context);
    }

    /**
     * Reset the no-change timeout
     * Call this when a forecast change is detected
     */
    resetNoChangeTimeout(cityId: string): void;
    resetNoChangeTimeout(context: StateContext): void;
    resetNoChangeTimeout(cityOrContext: string | StateContext): void {
        const context = typeof cityOrContext === 'string'
            ? this.getOrCreateContext(cityOrContext)
            : cityOrContext;

        // Only reset if in FETCH_MODE
        if (context.state !== 'FETCH_MODE') {
            return;
        }

        // Clear existing no-change timeout
        if (context.noChangeTimeoutId) {
            clearTimeout(context.noChangeTimeoutId);
        }

        // Set new no-change timeout
        context.noChangeTimeoutId = setTimeout(() => {
            logger.info(`⏰ No-change timeout reached for ${context.cityId}`);
            this.exitFetchMode(context.cityId, 'no_changes');
        }, this.noChangeExitMs);

        // Update last change timestamp
        context.lastForecastChange = new Date();
    }

    /**
     * Record a provider fetch attempt
     */
    recordProviderFetch(cityId: string, providerName: string, success: boolean): void {
        const context = this.getOrCreateContext(cityId);
        const now = new Date();

        context.lastProviderFetch.set(providerName, now);

        if (success) {
            // Reset error count on success
            context.providerErrorCounts.set(providerName, 0);
        } else {
            // Increment error count
            const currentErrors = context.providerErrorCounts.get(providerName) || 0;
            context.providerErrorCounts.set(providerName, currentErrors + 1);
        }
    }

    /**
     * Get consecutive error count for a provider
     */
    getProviderErrorCount(cityId: string, providerName: string): number {
        const context = this.getOrCreateContext(cityId);
        return context.providerErrorCounts.get(providerName) || 0;
    }

    /**
     * Check if a provider should be skipped due to too many errors
     */
    shouldSkipProvider(cityId: string, providerName: string, maxErrors: number = 3): boolean {
        return this.getProviderErrorCount(cityId, providerName) >= maxErrors;
    }

    /**
     * Check if a webhook ID has been processed (idempotency)
     */
    hasProcessedWebhook(cityId: string, webhookId: string): boolean {
        const context = this.getOrCreateContext(cityId);
        return context.processedWebhookIds.has(webhookId);
    }

    /**
     * Mark a webhook ID as processed
     */
    markWebhookProcessed(cityId: string, webhookId: string): void {
        const context = this.getOrCreateContext(cityId);
        context.processedWebhookIds.add(webhookId);

        // Keep set size manageable
        if (context.processedWebhookIds.size > 1000) {
            const toDelete = Array.from(context.processedWebhookIds).slice(0, 500);
            for (const id of toDelete) {
                context.processedWebhookIds.delete(id);
            }
        }
    }

    /**
     * Get all cities currently in FETCH_MODE
     */
    getCitiesInFetchMode(): string[] {
        const cities: string[] = [];
        for (const [cityId, context] of this.cityStates.entries()) {
            if (context.state === 'FETCH_MODE') {
                cities.push(cityId);
            }
        }
        return cities;
    }

    /**
     * Get all cities currently in IDLE state
     */
    getCitiesInIdle(): string[] {
        const cities: string[] = [];
        for (const [cityId, context] of this.cityStates.entries()) {
            if (context.state === 'IDLE') {
                cities.push(cityId);
            }
        }
        return cities;
    }

    /**
     * Get statistics for all cities
     */
    getStats(): {
        totalCities: number;
        inFetchMode: number;
        inIdle: number;
        citiesInFetchMode: string[];
    } {
        const citiesInFetchMode = this.getCitiesInFetchMode();
        return {
            totalCities: this.cityStates.size,
            inFetchMode: citiesInFetchMode.length,
            inIdle: this.getCitiesInIdle().length,
            citiesInFetchMode,
        };
    }

    /**
     * Dispose of the state machine and clean up resources
     */
    dispose(): void {
        for (const context of this.cityStates.values()) {
            this.clearTimeouts(context);
        }
        this.cityStates.clear();
        this.removeAllListeners();
        logger.info('ForecastStateMachine disposed');
    }
}

// Export singleton instance
export const forecastStateMachine = new ForecastStateMachine();
