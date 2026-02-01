/**
 * Hybrid Weather Controller
 * Main state machine controller managing four operational modes:
 * - OPEN_METEO_POLLING: Time-based polling using Open-Meteo with UTC urgency windows
 * - METEOSOURCE_POLLING: 1-second polling using Meteosource API (batch requests)
 * - WEBSOCKET_REST: Tomorrow.io WebSocket rest mode (pure rest, no polling)
 * - ROUND_ROBIN_BURST: 60-second burst polling across providers (1 req/sec)
 *
 * URGENCY WINDOWS (UTC):
 * - HIGH: 00:30-02:30 and 12:30-14:30 UTC (poll every 1 second using Open-Meteo)
 * - MEDIUM: 06:30-07:30 and 18:30-19:30 UTC (poll every 1 second using Meteosource)
 * - LOW: Outside these windows - Meteosource polling every 1 second
 *
 * BURST MODE:
 * - Triggered ONLY by WebSocket-detected forecast updates
 * - NOT triggered during HIGH/MEDIUM urgency windows
 * - 1 request per second for exactly 60 seconds
 * - Round-robin through: Open-Meteo (batched) → Tomorrow.io → OpenWeather
 * - Open-Meteo skipped if quota exceeded (9,500 calls)
 *
 * METEOSOURCE POLLING MODE:
 * - Dedicated 1-second polling mode using Meteosource API
 * - Uses batch requests for efficient multi-city polling
 * - Used for LOW and MEDIUM urgency windows
 * - Requires METEOSOURCE_API_KEY to be configured
 *
 * STATE TRANSITIONS:
 * - Entering HIGH window: Switch to Open-Meteo polling (1s)
 * - Entering MEDIUM window: Switch to Meteosource polling (1s)
 * - LOW urgency: Meteosource polling (1s)
 * - Burst completes: Return to appropriate urgency-based mode
 *
 * CRITICAL LATENCY REQUIREMENT - SUB-5-SECOND REACTION TIME:
 * - During HIGH/MEDIUM/LOW urgency: polling uses useCache=false
 *   This ensures fresh data on every poll (every 1s for all urgency levels)
 *   guaranteeing sub-5-second detection of forecast changes
 * - During burst mode: Open-Meteo uses useCache=false for immediate response
 *
 * CACHE STRATEGY:
 * - Open-Meteo client implements intelligent caching based on model update schedules
 * - Meteosource uses 60-second TTL cache to minimize API calls
 * - ECMWF/GFS update at 00:00, 06:00, 12:00, 18:00 UTC (4x daily)
 * - Cache is ONLY used during non-urgency periods (if any)
 * - During critical windows, cache is bypassed to ensure sub-5-second latency
 */

import { EventEmitter } from 'events';
import { eventBus } from './event-bus.js';
import { apiCallTracker, ApiCallTracker } from './api-call-tracker.js';
import { ForecastStateMachine } from './forecast-state-machine.js';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherProviderManager } from '../weather/provider-manager.js';
import { WeatherService } from '../weather/index.js';
import { findCity, CityLocation, Coordinates } from '../weather/types.js';

/**
 * Urgency level for Open-Meteo polling
 */
export type UrgencyLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Operational modes for the hybrid weather system
 */
export type HybridWeatherMode = 
    | 'OPEN_METEO_POLLING' 
    | 'METEOSOURCE_POLLING'
    | 'WEBSOCKET_REST' 
    | 'ROUND_ROBIN_BURST';

/**
 * Mode transition reasons
 */
export type ModeTransitionReason =
    | 'urgency_window_entered'  // Entered HIGH/MEDIUM urgency window
    | 'urgency_window_exited'   // Exited urgency window (LOW urgency)
    | 'webhook_trigger'         // Tomorrow.io webhook triggered
    | 'forecast_change'         // Significant forecast change detected via WebSocket
    | 'burst_complete'          // Round-robin burst completed
    | 'quota_exceeded'          // Open-Meteo quota exceeded
    | 'manual'                  // Manual override
    | 'error_recovery';         // Recovering from error state

/**
 * Mode transition event
 */
export interface ModeTransition {
    from: HybridWeatherMode;
    to: HybridWeatherMode;
    timestamp: Date;
    reason: ModeTransitionReason;
    cityId?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Mode configuration
 */
export interface ModeConfig {
    mode: HybridWeatherMode;
    durationMs: number | null;  // null means indefinite
    pollIntervalMs: number | null;  // null means no polling
    providers: string[];
    description: string;
}

/**
 * Mode statistics
 */
export interface ModeStats {
    mode: HybridWeatherMode;
    entryTime: Date;
    exitTime: Date | null;
    durationMs: number;
    apiCalls: number;
    forecastChanges: number;
    webhooksReceived: number;
}

/**
 * Urgency window configuration
 */
export interface UrgencyWindow {
    level: UrgencyLevel;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    pollIntervalMs: number;
}

/**
 * Hybrid Weather Controller State
 */
export interface HybridControllerState {
    currentMode: HybridWeatherMode;
    previousMode: HybridWeatherMode | null;
    modeEntryTime: Date;
    activeCities: Set<string>;
    isRunning: boolean;
    lastTransition: ModeTransition | null;
    modeHistory: ModeStats[];
    currentUrgency: UrgencyLevel;
    burstStartTime: Date | null;
    burstRequestsCompleted: number;
    isAutoMode: boolean;  // true = auto-switching enabled, false = manual override
}

// UTC Urgency Windows Configuration
const URGENCY_WINDOWS: UrgencyWindow[] = [
    // HIGH urgency: 00:30-02:30 UTC (poll every 1 second using Open-Meteo)
    { level: 'HIGH', startHour: 0, startMinute: 30, endHour: 2, endMinute: 30, pollIntervalMs: 1000 },
    // HIGH urgency: 12:30-14:30 UTC (poll every 1 second using Open-Meteo)
    { level: 'HIGH', startHour: 12, startMinute: 30, endHour: 14, endMinute: 30, pollIntervalMs: 1000 },
    // MEDIUM urgency: 06:30-07:30 UTC (poll every 1 second using Meteosource)
    { level: 'MEDIUM', startHour: 6, startMinute: 30, endHour: 7, endMinute: 30, pollIntervalMs: 1000 },
    // MEDIUM urgency: 18:30-19:30 UTC (poll every 1 second using Meteosource)
    { level: 'MEDIUM', startHour: 18, startMinute: 30, endHour: 19, endMinute: 30, pollIntervalMs: 1000 },
];

// Burst mode configuration: 1 request per second for 60 seconds
const BURST_CONFIG = {
    durationMs: 60000,  // Exactly 60 seconds
    intervalMs: 1000,   // 1 request per second (not parallel)
    providers: ['openmeteo', 'tomorrow', 'openweather'],  // Round-robin order
};

// Mode configurations (updated for new requirements)
const MODE_CONFIGS: Record<HybridWeatherMode, ModeConfig> = {
    OPEN_METEO_POLLING: {
        mode: 'OPEN_METEO_POLLING',
        durationMs: null, // Runs indefinitely until urgency window changes
        pollIntervalMs: 1000, // 1 second for HIGH urgency
        providers: ['openmeteo'],
        description: 'HIGH urgency polling using Open-Meteo (1 second)',
    },
    METEOSOURCE_POLLING: {
        mode: 'METEOSOURCE_POLLING',
        durationMs: null, // Runs indefinitely until urgency window changes
        pollIntervalMs: 1000, // 1 second for LOW and MEDIUM urgency
        providers: ['meteosource'],
        description: 'LOW/MEDIUM urgency polling using Meteosource (1 second)',
    },
    WEBSOCKET_REST: {
        mode: 'WEBSOCKET_REST',
        durationMs: null, // Runs indefinitely until urgency window or burst trigger
        pollIntervalMs: null, // Pure rest mode - NO polling
        providers: ['tomorrow'],  // WebSocket only
        description: 'Tomorrow.io WebSocket rest mode - NO polling, minimal API usage',
    },
    ROUND_ROBIN_BURST: {
        mode: 'ROUND_ROBIN_BURST',
        durationMs: 60000, // Exactly 60 seconds
        pollIntervalMs: 1000, // 1 request per second
        providers: ['openmeteo', 'tomorrow', 'openweather'],  // Round-robin order
        description: 'High-frequency burst: 1 req/sec for 60s, rotating through providers',
    },
};

/**
 * Hybrid Weather Controller
 * Manages the three-state weather fetching system with UTC urgency windows
 */
export class HybridWeatherController extends EventEmitter {
    private state: HybridControllerState;
    private stateMachine: ForecastStateMachine;
    private dataStore: DataStore;
    private apiTracker: ApiCallTracker;
    private providerManager: WeatherProviderManager;
    private weatherService: WeatherService;
    
    // Timers
    private urgencyCheckIntervalId: NodeJS.Timeout | null = null;
    private burstIntervalId: NodeJS.Timeout | null = null;
    private openMeteoPollIntervalId: NodeJS.Timeout | null = null;
    private meteosourcePollIntervalId: NodeJS.Timeout | null = null;
    
    // Burst mode tracking
    private burstModeActive: boolean = false;
    private burstProviderIndex: number = 0;
    private burstCityId: string | null = null;
    private burstRequestCount: number = 0;
    private burstStartTime: Date | null = null;

    // WebSocket rest mode tracking
    private websocketRestActive: boolean = false;
    private websocketCityId: string | null = null;

    // Open-Meteo polling tracking
    private openMeteoPollingActive: boolean = false;
    private currentPollInterval: number = 5000; // Default fallback
    
    // Meteosource polling tracking
    private meteosourcePollingActive: boolean = false;

    constructor(
        stateMachine: ForecastStateMachine,
        dataStore: DataStore,
        providerManager?: WeatherProviderManager,
        weatherService?: WeatherService
    ) {
        super();
        
        this.stateMachine = stateMachine;
        this.dataStore = dataStore;
        this.apiTracker = apiCallTracker;
        this.providerManager = providerManager || new WeatherProviderManager();
        this.weatherService = weatherService || new WeatherService();
        
        this.state = {
            currentMode: 'METEOSOURCE_POLLING', // Start in Meteosource polling mode (LOW urgency default)
            previousMode: null,
            modeEntryTime: new Date(),
            activeCities: new Set(),
            isRunning: false,
            lastTransition: null,
            modeHistory: [],
            currentUrgency: 'LOW',
            burstStartTime: null,
            burstRequestsCompleted: 0,
            isAutoMode: true,  // Start in auto mode
        };

        this.setupEventListeners();
        
        logger.info('HybridWeatherController initialized', {
            initialMode: this.state.currentMode,
        });
    }

    /**
     * Setup event listeners for integration with other components
     */
    private setupEventListeners(): void {
        // Listen for webhook triggers from Tomorrow.io
        eventBus.on('FORECAST_TRIGGER', async (event) => {
            const payload = event.payload as { provider: 'tomorrow.io'; cityId: string; triggerTimestamp: Date; location: Coordinates; forecastId?: string; updateType?: string };
            if (payload.provider === 'tomorrow.io') {
                await this.handleWebhookTrigger(
                    payload.cityId,
                    payload.location
                );
            }
        });

        // Listen for forecast changes detected via WebSocket
        eventBus.on('FORECAST_CHANGED', (event) => {
            const payload = event.payload as { cityId: string; marketId?: string; provider: string; previousValue?: number; newValue: number; changeAmount: number; timestamp: Date };
            // Only trigger burst if we're in LOW urgency (WebSocket rest mode)
            // AND the change came from WebSocket (not from polling)
            if (this.state.currentUrgency === 'LOW' && payload.provider === 'tomorrow.io') {
                this.handleWebSocketForecastChange(
                    payload.cityId,
                    payload.changeAmount
                );
            }
        });
    }

    /**
     * Start the hybrid weather controller
     */
    public start(): void {
        if (this.state.isRunning) {
            logger.warn('HybridWeatherController already running');
            return;
        }

        this.state.isRunning = true;
        logger.info('HybridWeatherController started');

        // Start urgency window checker (every 10 seconds)
        this.urgencyCheckIntervalId = setInterval(() => {
            this.checkUrgencyWindow();
        }, 10000);

        // Initial urgency check
        this.checkUrgencyWindow();

        this.emit('started', { timestamp: new Date() });
    }

    /**
     * Stop the hybrid weather controller
     */
    public stop(): void {
        if (!this.state.isRunning) {
            return;
        }

        this.state.isRunning = false;

        // Clear all timers
        this.clearAllTimers();

        // Stop burst mode if active
        this.stopBurstMode();

        // Stop Open-Meteo polling if active
        this.stopOpenMeteoPolling();
        
        // Stop Meteosource polling if active
        this.stopMeteosourcePolling();

        logger.info('HybridWeatherController stopped');
        this.emit('stopped', { timestamp: new Date() });
    }

    /**
     * Clear all active timers
     */
    private clearAllTimers(): void {
        if (this.urgencyCheckIntervalId) {
            clearInterval(this.urgencyCheckIntervalId);
            this.urgencyCheckIntervalId = null;
        }
        if (this.burstIntervalId) {
            clearInterval(this.burstIntervalId);
            this.burstIntervalId = null;
        }
        if (this.openMeteoPollIntervalId) {
            clearInterval(this.openMeteoPollIntervalId);
            this.openMeteoPollIntervalId = null;
        }
        if (this.meteosourcePollIntervalId) {
            clearInterval(this.meteosourcePollIntervalId);
            this.meteosourcePollIntervalId = null;
        }
    }

    /**
     * Check current UTC time and determine urgency level
     * Only performs auto-transitions when isAutoMode is true
     */
    private checkUrgencyWindow(): void {
        // Skip auto-switching if in manual mode
        if (!this.state.isAutoMode) {
            logger.debug('Skipping urgency check - manual mode active');
            return;
        }

        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const currentTime = utcHour * 60 + utcMinute; // Minutes since midnight UTC

        let currentUrgency: UrgencyLevel = 'LOW';
        let pollInterval: number | null = null;

        for (const window of URGENCY_WINDOWS) {
            const startTime = window.startHour * 60 + window.startMinute;
            const endTime = window.endHour * 60 + window.endMinute;

            if (currentTime >= startTime && currentTime < endTime) {
                currentUrgency = window.level;
                pollInterval = window.pollIntervalMs;
                break;
            }
        }

        // Handle urgency level changes
        if (currentUrgency !== this.state.currentUrgency) {
            logger.info(`🕐 Urgency window change: ${this.state.currentUrgency} → ${currentUrgency}`, {
                utcTime: `${utcHour.toString().padStart(2, '0')}:${utcMinute.toString().padStart(2, '0')}`,
            });

            const previousUrgency = this.state.currentUrgency;
            this.state.currentUrgency = currentUrgency;

            // Handle state transitions based on urgency (only in auto mode)
            if (currentUrgency === 'HIGH') {
                // HIGH urgency: Switch to Open-Meteo polling (1 second)
                if (this.state.currentMode !== 'OPEN_METEO_POLLING') {
                    this.transitionTo('OPEN_METEO_POLLING', 'urgency_window_entered');
                }
                // Update poll interval
                if (pollInterval) {
                    this.currentPollInterval = pollInterval;
                    this.updateOpenMeteoPollingInterval(pollInterval);
                }
            } else if (currentUrgency === 'MEDIUM' || currentUrgency === 'LOW') {
                // MEDIUM and LOW urgency: Switch to Meteosource polling (1 second)
                if (this.state.currentMode !== 'METEOSOURCE_POLLING') {
                    this.transitionTo('METEOSOURCE_POLLING', currentUrgency === 'MEDIUM' ? 'urgency_window_entered' : 'urgency_window_exited');
                }
            }
        } else if (currentUrgency === 'HIGH' && pollInterval) {
            // Still in HIGH urgency window, ensure correct poll interval
            if (this.currentPollInterval !== pollInterval) {
                this.currentPollInterval = pollInterval;
                this.updateOpenMeteoPollingInterval(pollInterval);
            }
        }
    }

    /**
     * Get current controller state
     */
    public getState(): HybridControllerState {
        return { ...this.state };
    }

    /**
     * Get current mode
     */
    public getCurrentMode(): HybridWeatherMode {
        return this.state.currentMode;
    }

    /**
     * Check if a specific mode is active
     */
    public isModeActive(mode: HybridWeatherMode): boolean {
        return this.state.currentMode === mode;
    }

    /**
     * Get mode configuration
     */
    public getModeConfig(mode: HybridWeatherMode): ModeConfig {
        return MODE_CONFIGS[mode];
    }

    /**
     * Get current mode configuration
     */
    public getCurrentModeConfig(): ModeConfig {
        return MODE_CONFIGS[this.state.currentMode];
    }

    /**
     * Get time spent in current mode (ms)
     */
    public getCurrentModeDuration(): number {
        return Date.now() - this.state.modeEntryTime.getTime();
    }

    /**
     * Get current urgency level
     */
    public getCurrentUrgency(): UrgencyLevel {
        return this.state.currentUrgency;
    }

    /**
     * Transition to a new mode
     */
    public async transitionTo(
        newMode: HybridWeatherMode, 
        reason: ModeTransitionReason = 'manual',
        cityId?: string
    ): Promise<boolean> {
        if (newMode === this.state.currentMode) {
            logger.debug(`Already in mode ${newMode}, no transition needed`);
            return true;
        }

        const previousMode = this.state.currentMode;
        
        // Create transition record
        const transition: ModeTransition = {
            from: previousMode,
            to: newMode,
            timestamp: new Date(),
            reason,
            cityId,
        };

        logger.info(`🔄 Mode transition: ${previousMode} → ${newMode}`, { reason, cityId });

        // Exit current mode
        await this.exitCurrentMode();

        // Update state
        this.state.previousMode = previousMode;
        this.state.currentMode = newMode;
        this.state.modeEntryTime = new Date();
        this.state.lastTransition = transition;

        // Enter new mode
        await this.enterNewMode(newMode, cityId);

        // Emit transition event
        this.emit('modeTransition', transition);

        return true;
    }

    /**
     * Exit the current mode - cleanup
     */
    private async exitCurrentMode(): Promise<void> {
        switch (this.state.currentMode) {
            case 'OPEN_METEO_POLLING':
                this.exitOpenMeteoPolling();
                break;
            case 'METEOSOURCE_POLLING':
                this.exitMeteosourcePolling();
                break;
            case 'WEBSOCKET_REST':
                await this.exitWebsocketRest();
                break;
            case 'ROUND_ROBIN_BURST':
                this.exitRoundRobinBurst();
                break;
        }

        // Record mode stats
        const duration = Date.now() - this.state.modeEntryTime.getTime();
        const stats: ModeStats = {
            mode: this.state.currentMode,
            entryTime: this.state.modeEntryTime,
            exitTime: new Date(),
            durationMs: duration,
            apiCalls: this.apiTracker.getTotalCallsToday(),
            forecastChanges: 0, // Would track separately
            webhooksReceived: 0, // Would track separately
        };
        this.state.modeHistory.push(stats);
    }

    /**
     * Enter a new mode
     */
    private async enterNewMode(mode: HybridWeatherMode, cityId?: string): Promise<void> {
        switch (mode) {
            case 'OPEN_METEO_POLLING':
                this.enterOpenMeteoPolling();
                break;
            case 'METEOSOURCE_POLLING':
                this.enterMeteosourcePolling();
                break;
            case 'WEBSOCKET_REST':
                await this.enterWebsocketRest(cityId);
                break;
            case 'ROUND_ROBIN_BURST':
                this.enterRoundRobinBurst(cityId);
                break;
        }
    }

    // ====================
    // OPEN_METEO_POLLING Mode
    // ====================

    /**
     * Enter OPEN_METEO_POLLING mode
     */
    private enterOpenMeteoPolling(): void {
        logger.info('📡 Entering OPEN_METEO_POLLING mode', {
            urgency: this.state.currentUrgency,
            pollInterval: this.currentPollInterval,
        });
        
        this.openMeteoPollingActive = true;
        
        // Start polling with current urgency interval
        this.startOpenMeteoPolling(this.currentPollInterval);

        this.emit('modeEntered', { mode: 'OPEN_METEO_POLLING', urgency: this.state.currentUrgency });
    }

    /**
     * Start Open-Meteo polling with specified interval
     */
    private startOpenMeteoPolling(intervalMs: number): void {
        this.stopOpenMeteoPolling();
        
        logger.info(`Starting Open-Meteo polling every ${intervalMs}ms`);
        
        // Execute first poll immediately
        this.executeOpenMeteoPoll();
        
        // Set up interval
        this.openMeteoPollIntervalId = setInterval(() => {
            this.executeOpenMeteoPoll();
        }, intervalMs);
    }

    /**
     * Update Open-Meteo polling interval
     */
    private updateOpenMeteoPollingInterval(intervalMs: number): void {
        if (this.openMeteoPollingActive) {
            logger.info(`Updating Open-Meteo poll interval to ${intervalMs}ms`);
            this.startOpenMeteoPolling(intervalMs);
        }
    }

    /**
     * Execute a single Open-Meteo poll using TRUE BATCH REQUESTS
     * 
     * MANDATORY REQUIREMENT: All cities must be queried in ONE request
     * - Uses comma-separated latitude and longitude parameters
     * - One batched request counts as exactly ONE API call
     * - No per-city requests allowed (critical for 10,000 daily limit)
     * 
     * CRITICAL LATENCY REQUIREMENT - SUB-5-SECOND REACTION TIME:
     * - During HIGH/MEDIUM urgency windows: useCache=false ensures fresh data
     * - Polling every 2s (HIGH) or 5s (MEDIUM) with no cache delay
     * - This guarantees sub-5-second detection of forecast changes
     * - Cache is ONLY used during LOW urgency / WebSocket rest mode
     */
    private async executeOpenMeteoPoll(): Promise<void> {
        // Check if Open-Meteo quota exceeded
        if (this.apiTracker.isQuotaExceeded('openmeteo')) {
            logger.warn('Open-Meteo quota exceeded, skipping poll');
            return;
        }

        // Get active cities
        let cities = Array.from(this.state.activeCities);
        if (cities.length === 0) {
            // No active cities, poll all known cities from dataStore
            const allMarkets = this.dataStore.getAllMarkets();
            const citySet = new Set<string>();
            for (const market of allMarkets) {
                if (market.city) {
                    citySet.add(market.city.toLowerCase().replace(/\s+/g, '_'));
                }
            }
            cities = Array.from(citySet);
        }

        if (cities.length === 0) {
            logger.debug('No cities to poll in Open-Meteo mode');
            return;
        }

        // Resolve city IDs to CityLocation objects
        const cityLocations: Array<{ cityId: string; city: CityLocation }> = [];
        for (const cityId of cities) {
            const city = findCity(cityId);
            if (city) {
                cityLocations.push({ cityId, city });
            }
        }

        if (cityLocations.length === 0) {
            logger.debug('No valid city locations found for Open-Meteo batch poll');
            return;
        }

        try {
            // Get OpenMeteoClient directly for batch support
            const openMeteoProvider = this.providerManager.getProvider('openmeteo');
            
            // Check if OpenMeteo client has batch support
            if (!('getHourlyForecastBatch' in openMeteoProvider)) {
                logger.error('OpenMeteo provider does not support batch requests');
                return;
            }

            const openMeteoClient = openMeteoProvider as import('../weather/openmeteo-client.js').OpenMeteoClient;

            // Build batch request locations
            const locations = cityLocations.map(({ city }) => ({
                coords: city.coordinates,
                locationName: city.name
            }));

            // Check cache stats before request
            const cacheStatsBefore = openMeteoClient.getCacheStats?.();
            
            // CRITICAL: Disable cache during HIGH/MEDIUM urgency for sub-5-second reaction time
            // During LOW urgency, cache is used to conserve API calls
            const useCache = this.state.currentUrgency === 'LOW';
            
            logger.info(`🌤️ Open-Meteo BATCH request: ${locations.length} cities in 1 API call`, {
                cities: locations.map(l => l.locationName).join(', '),
                urgency: this.state.currentUrgency,
                useCache,
                cacheSize: cacheStatsBefore?.size || 0,
                cacheHitRate: cacheStatsBefore ? `${cacheStatsBefore.hitRate.toFixed(1)}%` : 'N/A',
            });

            // Execute SINGLE batch request
            // useCache=false during HIGH/MEDIUM urgency ensures sub-5-second detection of forecast changes
            const batchResults = await openMeteoClient.getHourlyForecastBatch(locations, useCache);

            // Record exactly ONE API call for the entire batch
            // Note: If all locations were cached, this might not actually make an API call
            this.apiTracker.recordCall('openmeteo', true);

            // Get cache stats after request
            const cacheStatsAfter = openMeteoClient.getCacheStats?.();

            // Distribute results back to individual cities and emit events
            for (let i = 0; i < batchResults.length && i < cityLocations.length; i++) {
                const result = batchResults[i];
                const { cityId } = cityLocations[i];

                // Emit provider fetch event (compatible with existing event types)
                eventBus.emit({
                    type: 'PROVIDER_FETCH',
                    payload: {
                        cityId,
                        provider: 'open-meteo',
                        success: true,
                        hasChanges: true,
                    },
                });

                logger.debug(`Open-Meteo batch result distributed for ${cityId}`);
            }

            logger.info(`✅ Open-Meteo batch poll complete: ${batchResults.length} cities, 1 API call`, {
                cacheHitRate: cacheStatsAfter ? `${cacheStatsAfter.hitRate.toFixed(1)}%` : 'N/A',
                cacheSize: cacheStatsAfter?.size || 0,
            });

        } catch (error) {
            // Record single failed API call for the batch
            this.apiTracker.recordCall('openmeteo', false);
            logger.error('Open-Meteo batch poll failed', {
                cityCount: cityLocations.length,
                error: (error as Error).message,
            });
        }
    }

    /**
     * Exit OPEN_METEO_POLLING mode
     */
    private exitOpenMeteoPolling(): void {
        logger.info('📡 Exiting OPEN_METEO_POLLING mode');
        
        this.openMeteoPollingActive = false;
        this.stopOpenMeteoPolling();
    }

    /**
     * Stop Open-Meteo polling
     */
    private stopOpenMeteoPolling(): void {
        if (this.openMeteoPollIntervalId) {
            clearInterval(this.openMeteoPollIntervalId);
            this.openMeteoPollIntervalId = null;
        }
    }

    // ====================
    // METEOSOURCE_POLLING Mode
    // ====================

    /**
     * Enter METEOSOURCE_POLLING mode
     */
    private enterMeteosourcePolling(): void {
        const pollInterval = MODE_CONFIGS.METEOSOURCE_POLLING.pollIntervalMs || 1000;
        logger.info('📡 Entering METEOSOURCE_POLLING mode', {
            pollInterval,
            description: '1-second polling with Meteosource batch requests',
        });

        this.meteosourcePollingActive = true;

        // Start polling with configured interval (1 second)
        this.startMeteosourcePolling(pollInterval);

        this.emit('modeEntered', { mode: 'METEOSOURCE_POLLING' });
    }

    /**
     * Start Meteosource polling with specified interval
     */
    private startMeteosourcePolling(intervalMs: number): void {
        this.stopMeteosourcePolling();
        
        logger.info(`Starting Meteosource polling every ${intervalMs}ms`);
        
        // Execute first poll immediately
        this.executeMeteosourcePoll();
        
        // Set up interval
        this.meteosourcePollIntervalId = setInterval(() => {
            this.executeMeteosourcePoll();
        }, intervalMs);
    }

    /**
     * Execute a single Meteosource poll using BATCH REQUESTS
     * 
     * METEOSOURCE API LIMITS:
     * - Free tier: 500 calls/day
     * - We use batch requests to minimize API calls
     * - 60-second cache TTL to avoid redundant calls
     * 
     * CRITICAL LATENCY REQUIREMENT:
     * - 2-second polling ensures sub-5-second detection
     * - Cache disabled during active polling for fresh data
     */
    private async executeMeteosourcePoll(): Promise<void> {
        // Check if Meteosource is configured
        const meteosourceProvider = this.providerManager.getProvider('meteosource');
        if (!meteosourceProvider) {
            logger.warn('Meteosource provider not available, skipping poll');
            return;
        }

        // Get active cities
        let cities = Array.from(this.state.activeCities);
        if (cities.length === 0) {
            // No active cities, poll all known cities from dataStore
            const allMarkets = this.dataStore.getAllMarkets();
            const citySet = new Set<string>();
            for (const market of allMarkets) {
                if (market.city) {
                    citySet.add(market.city.toLowerCase().replace(/\s+/g, '_'));
                }
            }
            cities = Array.from(citySet);
        }

        if (cities.length === 0) {
            logger.debug('No cities to poll in Meteosource mode');
            return;
        }

        // Resolve city IDs to CityLocation objects
        const cityLocations: Array<{ cityId: string; city: CityLocation }> = [];
        for (const cityId of cities) {
            const city = findCity(cityId);
            if (city) {
                cityLocations.push({ cityId, city });
            }
        }

        if (cityLocations.length === 0) {
            logger.debug('No valid city locations found for Meteosource batch poll');
            return;
        }

        try {
            // Check if Meteosource client has batch support
            if (!('getHourlyForecastBatch' in meteosourceProvider)) {
                logger.error('Meteosource provider does not support batch requests');
                return;
            }

            const meteosourceClient = meteosourceProvider as import('../weather/additional-providers.js').MeteosourceProvider;

            // Build batch request locations
            const locations = cityLocations.map(({ city }) => ({
                coords: city.coordinates,
                locationName: city.name
            }));

            logger.info(`🌤️ Meteosource BATCH request: ${locations.length} cities`, {
                cities: locations.map(l => l.locationName).join(', '),
            });

            // Execute batch request with cache disabled for fresh data
            // Meteosource has its own internal rate limiting
            const batchResults = await meteosourceClient.getHourlyForecastBatch(locations, false);

            // Record API calls (each city call counts separately for Meteosource)
            for (let i = 0; i < batchResults.length; i++) {
                this.apiTracker.recordCall('meteosource', true);
            }

            // Distribute results back to individual cities and emit events
            for (let i = 0; i < batchResults.length && i < cityLocations.length; i++) {
                const result = batchResults[i];
                const { cityId } = cityLocations[i];

                // Emit provider fetch event
                eventBus.emit({
                    type: 'PROVIDER_FETCH',
                    payload: {
                        cityId,
                        provider: 'meteosource',
                        success: true,
                        hasChanges: true,
                    },
                });

                logger.debug(`Meteosource batch result distributed for ${cityId}`);
            }

            logger.info(`✅ Meteosource batch poll complete: ${batchResults.length} cities`);

        } catch (error) {
            // Record failed API calls
            for (let i = 0; i < cityLocations.length; i++) {
                this.apiTracker.recordCall('meteosource', false);
            }
            logger.error('Meteosource batch poll failed', {
                cityCount: cityLocations.length,
                error: (error as Error).message,
            });
        }
    }

    /**
     * Exit METEOSOURCE_POLLING mode
     */
    private exitMeteosourcePolling(): void {
        logger.info('📡 Exiting METEOSOURCE_POLLING mode');
        
        this.meteosourcePollingActive = false;
        this.stopMeteosourcePolling();
    }
    
    /**
     * Stop Meteosource polling
     */
    private stopMeteosourcePolling(): void {
        if (this.meteosourcePollIntervalId) {
            clearInterval(this.meteosourcePollIntervalId);
            this.meteosourcePollIntervalId = null;
        }
    }

    // ====================
    // WEBSOCKET_REST Mode
    // ====================

    /**
     * Enter WEBSOCKET_REST mode
     */
    private async enterWebsocketRest(cityId?: string): Promise<void> {
        logger.info('🔌 Entering WEBSOCKET_REST mode (PURE REST - NO POLLING)', { cityId });
        
        this.websocketRestActive = true;
        this.websocketCityId = cityId || null;

        // Note: We maintain WebSocket connection but do NO polling
        // Forecast updates come exclusively via WebSocket/webhook

        this.emit('modeEntered', { mode: 'WEBSOCKET_REST', cityId });
    }

    /**
     * Exit WEBSOCKET_REST mode
     */
    private async exitWebsocketRest(): Promise<void> {
        logger.info('🔌 Exiting WEBSOCKET_REST mode');
        
        this.websocketRestActive = false;
        this.websocketCityId = null;
    }

    // ====================
    // ROUND_ROBIN_BURST Mode
    // ====================

    /**
     * Enter ROUND_ROBIN_BURST mode
     */
    private enterRoundRobinBurst(cityId?: string): void {
        logger.info('⚡ Entering ROUND_ROBIN_BURST mode', { 
            cityId,
            duration: '60 seconds',
            rate: '1 req/sec',
        });
        
        this.burstModeActive = true;
        this.burstCityId = cityId || null;
        this.burstProviderIndex = 0;
        this.burstRequestCount = 0;
        this.burstStartTime = new Date();
        this.state.burstStartTime = new Date();
        this.state.burstRequestsCompleted = 0;

        // Notify API tracker
        this.apiTracker.enterBurstMode();

        // Start burst polling (1 req/sec for 60 seconds)
        this.startBurstPolling();

        // Set timeout to end burst after exactly 60 seconds
        setTimeout(() => {
            this.handleBurstComplete();
        }, BURST_CONFIG.durationMs);

        this.emit('modeEntered', { mode: 'ROUND_ROBIN_BURST', cityId });
    }

    /**
     * Exit ROUND_ROBIN_BURST mode
     */
    private exitRoundRobinBurst(): void {
        logger.info('⚡ Exiting ROUND_ROBIN_BURST mode');
        
        this.stopBurstMode();
        this.burstCityId = null;
        this.burstRequestCount = 0;
    }

    /**
     * Start burst polling across providers
     * 1 request per second, rotating through providers in order
     */
    private startBurstPolling(): void {
        // Execute first poll immediately
        this.executeBurstPoll();
        
        // Set up interval for 1 request per second
        this.burstIntervalId = setInterval(() => {
            this.executeBurstPoll();
        }, BURST_CONFIG.intervalMs);
    }

    /**
     * Stop burst polling
     */
    private stopBurstMode(): void {
        this.burstModeActive = false;
        
        if (this.burstIntervalId) {
            clearInterval(this.burstIntervalId);
            this.burstIntervalId = null;
        }

        // Notify API tracker
        this.apiTracker.exitBurstMode();
    }

    /**
     * Execute a single burst poll
     * Rotates through providers: Open-Meteo → Tomorrow.io → OpenWeather
     * 
     * CRITICAL LATENCY REQUIREMENT - SUB-5-SECOND REACTION TIME:
     * - Burst mode is triggered by WebSocket-detected forecast changes
     * - ALWAYS uses useCache=false to get fresh data immediately
     * - This ensures immediate response to forecast updates
     */
    private async executeBurstPoll(): Promise<void> {
        if (!this.burstModeActive) {
            return;
        }

        // Check if we've reached 60 seconds
        if (this.burstStartTime) {
            const elapsed = Date.now() - this.burstStartTime.getTime();
            if (elapsed >= BURST_CONFIG.durationMs) {
                this.handleBurstComplete();
                return;
            }
        }

        // Get current provider in rotation
        const providerName = BURST_CONFIG.providers[this.burstProviderIndex];
        
        // Skip Open-Meteo if quota exceeded
        if (providerName === 'openmeteo' && this.apiTracker.isQuotaExceeded('openmeteo')) {
            logger.warn('Open-Meteo quota exceeded, skipping in burst rotation');
            this.advanceBurstProvider();
            return;
        }

        // Skip if provider is rate limited
        if (this.apiTracker.isRateLimited(providerName)) {
            logger.debug(`Skipping rate-limited provider in burst: ${providerName}`);
            this.advanceBurstProvider();
            return;
        }

        // Get cities to poll
        const cities = this.burstCityId 
            ? [this.burstCityId]
            : Array.from(this.state.activeCities);

        if (cities.length === 0) {
            // Fallback to all known cities
            const allMarkets = this.dataStore.getAllMarkets();
            const citySet = new Set<string>();
            for (const market of allMarkets) {
                if (market.city) {
                    citySet.add(market.city.toLowerCase().replace(/\s+/g, '_'));
                }
            }
            cities.push(...Array.from(citySet));
        }

        if (cities.length === 0) {
            logger.debug('No cities to poll in burst mode');
            this.advanceBurstProvider();
            return;
        }

        // Execute poll for current provider
        const cityId = cities[0]; // Poll first city in rotation
        const city = findCity(cityId);
        
        if (!city) {
            logger.warn(`City not found for burst poll: ${cityId}`);
            this.advanceBurstProvider();
            return;
        }

        try {
            let success = false;

            switch (providerName) {
                case 'openmeteo':
                    // Use OpenMeteoClient directly with useCache=false for burst mode
                    // This ensures immediate detection of forecast changes
                    const openMeteoProvider = this.providerManager.getProvider('openmeteo');
                    if ('getHourlyForecast' in openMeteoProvider) {
                        const openMeteoClient = openMeteoProvider as import('../weather/openmeteo-client.js').OpenMeteoClient;
                        // CRITICAL: useCache=false ensures fresh data during burst
                        await openMeteoClient.getHourlyForecast(city.coordinates, false);
                        success = true;
                    }
                    break;
                case 'tomorrow':
                    // Tomorrow.io - use provider manager
                    const tomorrowProvider = this.providerManager.getProvider(cityId, 0);
                    if (tomorrowProvider && tomorrowProvider.name.toLowerCase().includes('tomorrow')) {
                        await tomorrowProvider.getHourlyForecast(city.coordinates);
                        success = true;
                    }
                    break;
                case 'openweather':
                    // OpenWeather - use provider manager
                    const openWeatherProvider = this.providerManager.getProvider(cityId, 1);
                    if (openWeatherProvider && openWeatherProvider.name.toLowerCase().includes('openweather')) {
                        await openWeatherProvider.getHourlyForecast(city.coordinates);
                        success = true;
                    }
                    break;
            }

            if (success) {
                this.apiTracker.recordCall(providerName, true);
                this.burstRequestCount++;
                this.state.burstRequestsCompleted++;
                
                logger.debug(`Burst poll: ${providerName} for ${cityId} (${this.burstRequestCount}/60)`);

                // Emit event for forecast update
                eventBus.emit({
                    type: 'PROVIDER_FETCH',
                    payload: {
                        cityId,
                        provider: providerName,
                        success: true,
                        hasChanges: true,
                    },
                });
            }
        } catch (error) {
            this.apiTracker.recordCall(providerName, false);
            logger.error(`Burst poll failed: ${providerName}`, {
                error: (error as Error).message,
                cityId,
            });

            // Emit failure event
            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: providerName,
                    success: false,
                    hasChanges: false,
                    error: (error as Error).message,
                },
            });
        }

        // Advance to next provider in rotation
        this.advanceBurstProvider();
    }

    /**
     * Advance to next provider in burst rotation
     */
    private advanceBurstProvider(): void {
        this.burstProviderIndex = (this.burstProviderIndex + 1) % BURST_CONFIG.providers.length;
    }

    /**
     * Handle burst completion (after 60 seconds)
     */
    private async handleBurstComplete(): Promise<void> {
        logger.info('✅ Burst mode completed', {
            totalRequests: this.burstRequestCount,
            duration: '60 seconds',
        });

        // Stop burst mode
        this.stopBurstMode();

        // Transition back to appropriate mode based on urgency
        // HIGH urgency: Open-Meteo polling (1 second)
        // MEDIUM/LOW urgency: Meteosource polling (1 second)
        if (this.state.currentUrgency === 'HIGH') {
            await this.transitionTo('OPEN_METEO_POLLING', 'burst_complete');
        } else {
            await this.transitionTo('METEOSOURCE_POLLING', 'burst_complete');
        }
    }

    // ====================
    // Event Handlers
    // ====================

    /**
     * Handle webhook trigger from Tomorrow.io
     */
    private async handleWebhookTrigger(cityId: string, location: Coordinates): Promise<void> {
        logger.info(`📨 Webhook trigger received for ${cityId}`);

        // Add city to active set
        this.state.activeCities.add(cityId);

        // Webhook triggers are logged but don't change polling mode
        // Polling mode is determined by urgency windows
        logger.debug(`Webhook received in ${this.state.currentMode} mode for ${cityId}`);
        // Note: We don't trigger burst mode on webhook - only on forecast changes
    }

    /**
     * Handle forecast change detected via WebSocket
     * This is the ONLY trigger for burst mode (not during HIGH/MEDIUM urgency)
     */
    private async handleWebSocketForecastChange(cityId: string, changeAmount: number): Promise<void> {
        const significantChangeThreshold = 2.0; // degrees or percentage points

        // Only trigger burst if:
        // 1. Change is significant
        // 2. We're in LOW urgency (not in HIGH/MEDIUM window)
        // 3. We're not already in burst mode
        if (Math.abs(changeAmount) >= significantChangeThreshold &&
            this.state.currentUrgency === 'LOW' &&
            this.state.currentMode !== 'ROUND_ROBIN_BURST') {
            
            logger.info(`📊 Significant forecast change via WebSocket: ${changeAmount} for ${cityId}`, {
                urgency: this.state.currentUrgency,
            });

            // Trigger burst mode
            await this.transitionTo('ROUND_ROBIN_BURST', 'forecast_change', cityId);
        }
    }

    /**
     * Trigger manual burst mode for a specific city
     */
    public async triggerBurstMode(cityId: string): Promise<void> {
        logger.info(`🚀 Manual burst mode triggered for ${cityId}`);
        await this.transitionTo('ROUND_ROBIN_BURST', 'manual', cityId);
    }

    /**
     * Return to normal mode (Meteosource or Open-Meteo based on urgency)
     * This enables auto-switching and transitions to the appropriate mode
     */
    public async returnToNormal(): Promise<void> {
        logger.info('⏮️ Returning to auto mode - auto-switching enabled');

        // Enable auto mode
        this.state.isAutoMode = true;

        // Immediately check urgency and transition to appropriate mode
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const currentTime = utcHour * 60 + utcMinute;

        let targetUrgency: UrgencyLevel = 'LOW';
        for (const window of URGENCY_WINDOWS) {
            const startTime = window.startHour * 60 + window.startMinute;
            const endTime = window.endHour * 60 + window.endMinute;
            if (currentTime >= startTime && currentTime < endTime) {
                targetUrgency = window.level;
                break;
            }
        }

        // Update urgency state
        this.state.currentUrgency = targetUrgency;

        // Transition to appropriate mode based on urgency
        // HIGH urgency: Open-Meteo polling (1 second)
        // MEDIUM/LOW urgency: Meteosource polling (1 second)
        if (targetUrgency === 'HIGH') {
            await this.transitionTo('OPEN_METEO_POLLING', 'urgency_window_entered');
        } else {
            await this.transitionTo('METEOSOURCE_POLLING', targetUrgency === 'MEDIUM' ? 'urgency_window_entered' : 'manual');
        }

        this.emit('autoModeEnabled', { timestamp: new Date(), urgency: targetUrgency });
    }

    /**
     * Force transition to a specific mode (for testing/emergencies)
     * This disables auto-switching until returnToNormal() is called
     */
    public async forceMode(mode: HybridWeatherMode, reason: string = 'manual'): Promise<void> {
        logger.warn(`🚨 Force mode transition to ${mode}`, { reason });
        
        // Disable auto mode when forcing a specific mode
        this.state.isAutoMode = false;
        logger.info('🚫 Auto-switching disabled - manual mode active');
        
        await this.transitionTo(mode, reason as ModeTransitionReason);
        
        this.emit('autoModeDisabled', { timestamp: new Date(), forcedMode: mode, reason });
    }

    /**
     * Get comprehensive status report
     */
    public getStatusReport(): {
        state: HybridControllerState;
        modeConfig: ModeConfig;
        modeDuration: number;
        apiStatus: ReturnType<ApiCallTracker['getStatusReport']>;
        burstActive: boolean;
        websocketActive: boolean;
        openMeteoPollingActive: boolean;
        burstProgress: { elapsedMs: number; requestsCompleted: number; totalRequests: number } | null;
        nextUrgencyWindow: { level: UrgencyLevel; timeUntil: string } | null;
        isAutoMode: boolean;
        cacheStats: { size: number; hitRate: number; hits: number; misses: number } | null;
        nextModelUpdate: string | null;
    } {
        // Calculate burst progress if active
        let burstProgress = null;
        if (this.burstModeActive && this.burstStartTime) {
            const elapsedMs = Date.now() - this.burstStartTime.getTime();
            burstProgress = {
                elapsedMs,
                requestsCompleted: this.burstRequestCount,
                totalRequests: 60, // 1 req/sec for 60 seconds
            };
        }

        // Calculate next urgency window
        const nextWindow = this.getNextUrgencyWindow();
        
        // Get cache stats from OpenMeteo client
        let cacheStats = null;
        let nextModelUpdate: string | null = null;
        try {
            const openMeteoProvider = this.providerManager.getProvider('openmeteo');
            if (openMeteoProvider && 'getCacheStats' in openMeteoProvider) {
                const openMeteoClient = openMeteoProvider as import('../weather/openmeteo-client.js').OpenMeteoClient;
                const stats = openMeteoClient.getCacheStats?.();
                if (stats) {
                    cacheStats = {
                        size: stats.size,
                        hitRate: stats.hitRate,
                        hits: stats.hits,
                        misses: stats.misses,
                    };
                }
                
                // Get next model update time
                const nextUpdate = openMeteoClient.getNextModelUpdateTime?.();
                if (nextUpdate) {
                    const now = new Date();
                    const diffMs = nextUpdate.getTime() - now.getTime();
                    const diffMins = Math.round(diffMs / 60000);
                    nextModelUpdate = diffMins > 60 
                        ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
                        : `${diffMins}m`;
                }
            }
        } catch (e) {
            // Ignore errors when getting cache stats
        }

        return {
            state: this.getState(),
            modeConfig: this.getCurrentModeConfig(),
            modeDuration: this.getCurrentModeDuration(),
            apiStatus: this.apiTracker.getStatusReport(),
            burstActive: this.burstModeActive,
            websocketActive: this.websocketRestActive,
            openMeteoPollingActive: this.openMeteoPollingActive,
            burstProgress,
            nextUrgencyWindow: nextWindow,
            isAutoMode: this.state.isAutoMode,
            cacheStats,
            nextModelUpdate,
        };
    }

    /**
     * Get next urgency window information
     */
    private getNextUrgencyWindow(): { level: UrgencyLevel; timeUntil: string } | null {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const currentTime = utcHour * 60 + utcMinute;

        // Find next window
        let nextWindow: UrgencyWindow | null = null;
        let minTimeDiff = Infinity;

        for (const window of URGENCY_WINDOWS) {
            const startTime = window.startHour * 60 + window.startMinute;
            let timeDiff = startTime - currentTime;
            
            // If window already passed today, check tomorrow
            if (timeDiff < 0) {
                timeDiff += 24 * 60; // Add 24 hours
            }

            if (timeDiff < minTimeDiff) {
                minTimeDiff = timeDiff;
                nextWindow = window;
            }
        }

        if (!nextWindow) return null;

        const hours = Math.floor(minTimeDiff / 60);
        const minutes = minTimeDiff % 60;
        const timeUntil = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

        return {
            level: nextWindow.level,
            timeUntil,
        };
    }
}
