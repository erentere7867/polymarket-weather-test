/**
 * Hybrid Weather Controller - Optimized Detection Window Architecture
 * 
 * POLLING STRATEGY:
 * - DETECTION_POLLING: Only during model update windows (HRRR, RAP, GFS, ECMWF)
 * - WEBSOCKET_IDLE: Outside detection windows - NO polling, just WebSocket listening
 * - BURST_MODE: 60-second burst when WebSocket alert received outside detection windows
 * 
 * DETECTION WINDOWS (based on actual model output delays):
 * - HRRR: Every hour, window at +30-50 min (e.g., 00:30-00:50, 01:30-01:50)
 * - RAP: Every hour, window at +30-50 min
 * - GFS: 00/06/12/18 UTC, window at +3-15 min (very fast)
 * - ECMWF: 00/12 UTC, window at +30-50 min
 * 
 * This approach reduces API calls by ~70% compared to continuous polling,
 * while maintaining sub-5-second detection during critical update windows.
 * 
 * ADVANCED FEATURES:
 * - Data source priority system (S3 file > API > Webhook)
 * - Confidence scoring based on data source
 * - Reconciliation logic when sources disagree
 * - Staleness detection - prefer fresh API data over stale file data
 * - Adaptive detection windows based on historical learning
 * - Early detection mode that triggers on first sign of new data
 */

import { EventEmitter } from 'events';
import { EventBus, eventBus } from './event-bus.js';
import { apiCallTracker, ApiCallTracker } from './api-call-tracker.js';
import { ForecastStateMachine } from './forecast-state-machine.js';
import { DataStore } from './data-store.js';
import { logger } from '../logger.js';
import { WeatherProviderManager } from '../weather/provider-manager.js';
import { WeatherService, FileBasedIngestion, ConfirmationManager } from '../weather/index.js';
import { findCity, CityLocation, Coordinates, ModelType } from '../weather/types.js';
import { config } from '../config.js';

/**
 * Data source priority ranking (higher = more trusted)
 */
export type DataSourceType = 'S3_FILE' | 'API' | 'WEBHOOK' | 'CACHE';

export interface DataSourcePriority {
    source: DataSourceType;
    priority: number;        // 1-10, higher = more trusted
    confidenceWeight: number; // 0-1, multiplier for confidence
    maxStalenessMs: number;  // Maximum acceptable age
}

/**
 * Data source confidence scoring
 */
export interface DataConfidenceScore {
    source: DataSourceType;
    baseConfidence: number;
    freshnessMultiplier: number;
    reconciliationBonus: number;
    finalScore: number;
    timestamp: Date;
    stalenessMs: number;
}

/**
 * Reconciliation result when sources disagree
 */
export interface ReconciliationResult {
    marketId: string;
    selectedSource: DataSourceType;
    selectedValue: number;
    allSources: Array<{
        source: DataSourceType;
        value: number;
        confidence: number;
        timestamp: Date;
    }>;
    disagreementAmount: number;
    resolutionReason: string;
}

/**
 * Historical learning data for adaptive windows
 */
export interface HistoricalPublicationData {
    model: ModelType;
    cycleHour: number;
    expectedOffsetMinutes: number;
    actualOffsets: number[];  // Historical actual offsets
    averageOffset: number;
    stdDevOffset: number;
    reliabilityScore: number;  // 0-1 based on consistency
    lastUpdated: Date;
}

/**
 * Adaptive detection window
 */
export interface AdaptiveDetectionWindow {
    model: ModelType;
    cycleIntervalHours: number;
    baseStartOffsetMinutes: number;
    baseEndOffsetMinutes: number;
    adjustedStartOffset: number;
    adjustedEndOffset: number;
    confidence: number;
    pollIntervalMs: number;
}

/**
 * Early detection trigger
 */
export interface EarlyDetectionTrigger {
    model: ModelType;
    cycleHour: number;
    triggeredAt: Date;
    triggerSource: DataSourceType;
    confidence: number;
}

/**
 * Operational modes for the hybrid weather system
 */
export type HybridWeatherMode = 
    | 'DETECTION_POLLING'   // Poll during model update detection windows
    | 'WEBSOCKET_IDLE'      // No polling, just WebSocket listening
    | 'BURST_MODE'          // 60-second burst when WebSocket alert received
    | 'EARLY_DETECTION';    // Early detection mode triggered by first sign of data

/**
 * Mode transition reasons
 */
export type ModeTransitionReason =
    | 'detection_window_started'   // Entered a model detection window
    | 'detection_window_ended'     // Detection window ended
    | 'webhook_trigger'            // Tomorrow.io webhook triggered
    | 'burst_complete'             // Burst mode completed
    | 'quota_exceeded'             // Open-Meteo quota exceeded
    | 'manual'                     // Manual override
    | 'error_recovery'             // Recovering from error state
    | 'early_detection_triggered'  // Early detection mode triggered
    | 'early_detection_complete';  // Early detection completed

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
 * Detection window configuration for a weather model
 */
export interface DetectionWindowConfig {
    model: ModelType;
    cycleIntervalHours: number;    // How often the model runs (1, 6, 12 hours)
    startOffsetMinutes: number;    // Minutes after cycle start to begin polling
    endOffsetMinutes: number;      // Minutes after cycle start to end polling
    pollIntervalMs: number;        // How often to poll during window
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
    burstStartTime: Date | null;
    burstRequestsCompleted: number;
    isAutoMode: boolean;
    currentDetectionWindow: {
        model: ModelType;
        cycleHour: number;
        windowStart: Date;
        windowEnd: Date;
    } | null;
    earlyDetectionActive: boolean;
    lastReconciliationResult?: ReconciliationResult;
}

interface CityUpdateState {
    lastUpdateSource: 'GFS' | 'ECMWF' | 'OTHER';
    lastUpdateTimestamp: Date; // Wall-clock time when the update was processed
    lastModelRunTime?: Date;    // The 'runDate' of the model (e.g., 12z)
}

// Data source priority configuration
const DATA_SOURCE_PRIORITIES: Record<DataSourceType, DataSourcePriority> = {
    S3_FILE: {
        source: 'S3_FILE',
        priority: 10,
        confidenceWeight: 1.0,
        maxStalenessMs: 30 * 60 * 1000  // 30 minutes
    },
    API: {
        source: 'API',
        priority: 7,
        confidenceWeight: 0.85,
        maxStalenessMs: 10 * 60 * 1000  // 10 minutes
    },
    WEBHOOK: {
        source: 'WEBHOOK',
        priority: 5,
        confidenceWeight: 0.70,
        maxStalenessMs: 5 * 60 * 1000   // 5 minutes
    },
    CACHE: {
        source: 'CACHE',
        priority: 3,
        confidenceWeight: 0.50,
        maxStalenessMs: 2 * 60 * 1000   // 2 minutes
    }
};

// Detection window configurations based on actual model output delays
// These are precise windows when models typically publish new forecasts
const DETECTION_WINDOW_CONFIGS: DetectionWindowConfig[] = [
    // HRRR: Hourly runs, publishes at ~25-35 min (was 30-50)
    { model: 'HRRR', cycleIntervalHours: 1, startOffsetMinutes: 25, endOffsetMinutes: 45, pollIntervalMs: 2000 },

    // RAP: Hourly runs, publishes slightly faster than HRRR at ~25-32 min (was 30-50)
    { model: 'RAP', cycleIntervalHours: 1, startOffsetMinutes: 25, endOffsetMinutes: 40, pollIntervalMs: 2000 },

    // GFS: 4x daily, very fast output at ~5-10 min (was 3-15)
    { model: 'GFS', cycleIntervalHours: 6, startOffsetMinutes: 5, endOffsetMinutes: 20, pollIntervalMs: 2000 },

    // ECMWF: 2x daily (00/12 UTC), publishes at ~6-7 hours (360-420 min)
    { model: 'ECMWF', cycleIntervalHours: 12, startOffsetMinutes: 360, endOffsetMinutes: 420, pollIntervalMs: 2000 },
];

// Burst mode configuration: 2 second polling for 60 seconds
const BURST_CONFIG = {
    durationMs: 60000,  // 60 seconds
    intervalMs: 2000,   // 2 seconds (changed from 1s to match user requirement)
    providers: ['openmeteo', 'meteosource'],  // Primary providers
};

// Early detection configuration
const EARLY_DETECTION_CONFIG = {
    triggerThreshold: 0.7,  // Confidence threshold to trigger early detection
    maxDurationMs: 300000,  // 5 minutes max in early detection
    pollIntervalMs: 1000,   // 1 second polling in early detection
};

// Mode configurations
const MODE_CONFIGS: Record<HybridWeatherMode, ModeConfig> = {
    DETECTION_POLLING: {
        mode: 'DETECTION_POLLING',
        durationMs: null, // Runs until detection window ends
        pollIntervalMs: 2000, // 2 seconds as requested
        providers: ['openmeteo', 'meteosource'],
        description: 'Polling during model update detection window (2s interval)',
    },
    WEBSOCKET_IDLE: {
        mode: 'WEBSOCKET_IDLE',
        durationMs: null, // Runs indefinitely until detection window or burst trigger
        pollIntervalMs: null, // NO polling
        providers: ['tomorrow'],  // WebSocket only
        description: 'Idle mode - NO polling, WebSocket listening only',
    },
    BURST_MODE: {
        mode: 'BURST_MODE',
        durationMs: 60000, // 60 seconds
        pollIntervalMs: 2000, // 2 seconds
        providers: ['openmeteo', 'meteosource'],
        description: 'Burst polling triggered by WebSocket alert (2s for 60s)',
    },
    EARLY_DETECTION: {
        mode: 'EARLY_DETECTION',
        durationMs: 300000, // 5 minutes
        pollIntervalMs: 1000, // 1 second
        providers: ['openmeteo', 'meteosource'],
        description: 'Early detection mode triggered by first sign of new data',
    }
};

/**
 * Hybrid Weather Controller
 * Optimized for precise detection windows + WebSocket alerts
 */
export class HybridWeatherController extends EventEmitter {
    private state: HybridControllerState;
    private stateMachine: ForecastStateMachine;
    private dataStore: DataStore;
    private apiTracker: ApiCallTracker;
    private providerManager: WeatherProviderManager;
    private weatherService: WeatherService;
    
    // File-based ingestion components
    private fileBasedIngestion: FileBasedIngestion | null = null;
    private confirmationManager: ConfirmationManager | null = null;
    private fileBasedIngestionEnabled: boolean = config.ENABLE_FILE_BASED_INGESTION;
    private eventBus: EventBus;
    
    // Track which cities have file-confirmed data (to stop API polling)
    private fileConfirmedCities: Set<string> = new Set();
    
    // Data source tracking for reconciliation
    private sourceDataCache: Map<string, Map<DataSourceType, {
        value: number;
        timestamp: Date;
        confidence: number;
    }>> = new Map();
    
    // Historical learning data for adaptive windows
    private historicalData: Map<string, HistoricalPublicationData> = new Map();
    
    // Timers
    private detectionWindowCheckIntervalId: NodeJS.Timeout | null = null;
    private burstIntervalId: NodeJS.Timeout | null = null;
    private pollIntervalId: NodeJS.Timeout | null = null;
    private burstTimeoutId: NodeJS.Timeout | null = null;
    private earlyDetectionTimeoutId: NodeJS.Timeout | null = null;
    
    // Burst mode tracking
    private burstModeActive: boolean = false;
    private burstRequestCount: number = 0;
    private burstStartTime: Date | null = null;

    // Early detection tracking
    private earlyDetectionActive: boolean = false;
    private earlyDetectionStartTime: Date | null = null;

    // Polling tracking
    private pollingActive: boolean = false;
    
    // Shared forecast cache with 2-second TTL for coordination
    private forecastCache: Map<string, {
        data: {
            cityId: string;
            cityName: string;
            temperatureC: number;
            temperatureF: number;
            windSpeedMph: number;
            precipitationMm: number;
            timestamp: Date;
            source: DataSourceType;
            confidence: number;
        };
        expiresAt: Date;
    }> = new Map();
    private readonly FORECAST_CACHE_TTL_MS = 2000;

    // Track last batch update time
    private lastBatchUpdateTime: Date | null = null;
    
    // OPTIMIZED: Pre-computed city ID cache for fast normalization
    private cityIdCache: Map<string, string> = new Map();

    // Track last update state for each city for arbitration
    private cityUpdateStates: Map<string, CityUpdateState> = new Map();

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
        this.eventBus = EventBus.getInstance();
        
        // Pre-populate city ID cache for fast lookups
        this.initializeCityIdCache();
        
        this.state = {
            currentMode: 'WEBSOCKET_IDLE', // Start in idle mode
            previousMode: null,
            modeEntryTime: new Date(),
            activeCities: new Set(),
            isRunning: false,
            lastTransition: null,
            modeHistory: [],
            burstStartTime: null,
            burstRequestsCompleted: 0,
            isAutoMode: true,
            currentDetectionWindow: null,
            earlyDetectionActive: false,
        };

        this.setupEventListeners();
        
        // Initialize file-based ingestion if enabled
        if (this.fileBasedIngestionEnabled) {
            this.initializeFileBasedIngestion();
        }
        
        // Initialize historical learning data
        this.initializeHistoricalData();
        
        logger.info('HybridWeatherController initialized', {
            initialMode: this.state.currentMode,
            fileBasedIngestion: this.fileBasedIngestionEnabled,
        });
    }

    /**
     * OPTIMIZED: Initialize city ID cache for fast normalization
     */
    private initializeCityIdCache(): void {
        const commonCities = [
            'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
            'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose',
            'London', 'Paris', 'Berlin', 'Tokyo', 'Sydney', 'Buenos Aires',
            'Toronto', 'Mumbai', 'Dubai', 'Singapore', 'Hong Kong',
        ];
        
        for (const city of commonCities) {
            this.cityIdCache.set(city, city.toLowerCase().replace(/\s+/g, '_'));
        }
    }
    
    /**
     * OPTIMIZED: Fast city ID normalization using cache
     */
    private fastNormalizeCityId(cityName: string): string {
        const cached = this.cityIdCache.get(cityName);
        if (cached) return cached;
        
        const normalized = cityName.toLowerCase().replace(/\s+/g, '_');
        this.cityIdCache.set(cityName, normalized);
        return normalized;
    }

    /**
     * Initialize historical learning data
     */
    private initializeHistoricalData(): void {
        for (const config of DETECTION_WINDOW_CONFIGS) {
            for (let hour = 0; hour < 24; hour += config.cycleIntervalHours) {
                const key = `${config.model}_${hour}`;
                this.historicalData.set(key, {
                    model: config.model,
                    cycleHour: hour,
                    expectedOffsetMinutes: config.startOffsetMinutes,
                    actualOffsets: [],
                    averageOffset: config.startOffsetMinutes,
                    stdDevOffset: 5,
                    reliabilityScore: 0.5,
                    lastUpdated: new Date()
                });
            }
        }
    }

    /**
     * Initialize file-based ingestion system
     */
    private initializeFileBasedIngestion(): void {
        logger.info('📁 Initializing file-based ingestion system');
        
        this.fileBasedIngestion = new FileBasedIngestion({
            enabled: true,
            s3PollIntervalMs: config.S3_POLL_INTERVAL_MS,
            maxDetectionDurationMs: config.API_FALLBACK_MAX_DURATION_MINUTES * 60 * 1000,
            awsRegion: 'us-east-1',
            publicBuckets: true,
        });
        
        this.confirmationManager = new ConfirmationManager({
            maxWaitMinutes: config.API_FALLBACK_MAX_DURATION_MINUTES,
            emitUnconfirmed: true,
        });
        
        // Listen for FILE_CONFIRMED events
        this.eventBus.on('FILE_CONFIRMED', (event) => {
            if (event.type === 'FILE_CONFIRMED') {
                this.handleFileConfirmed(event.payload);
            }
        });
        
        logger.info('✅ File-based ingestion system initialized');
    }

    /**
     * Handle FILE_CONFIRMED event
     */
    private handleFileConfirmed(payload: {
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        cityData: Array<{
            cityName: string;
            coordinates: Coordinates;
            temperatureC: number;
            temperatureF: number;
            windSpeedMps: number;
            windSpeedMph: number;
            windDirection: number;
            precipitationRateMmHr: number;
            totalPrecipitationMm: number;
            totalPrecipitationIn: number;
        }>;
        timestamp: Date;
        source: 'FILE';
        detectionLatencyMs: number;
        downloadTimeMs: number;
        parseTimeMs: number;
        fileSize: number;
    }): void {
        logger.info(
            `📁 FILE_CONFIRMED: ${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z ` +
            `(${payload.cityData.length} cities, ${payload.detectionLatencyMs}ms latency)`
        );
        
        // Update historical learning data
        this.updateHistoricalData(payload.model, payload.cycleHour, payload.detectionLatencyMs);
        
        // Mark cities as file-confirmed and trigger opportunity re-scan
        for (const cityData of payload.cityData) {
            const cityId = cityData.cityName.toLowerCase().replace(/\s+/g, '_');
            
            // DUAL MODEL ARBITRATION LOGIC
            // Check if we should update this city based on model priority/timing
            if (!this.shouldUpdateForecast(cityId, payload.model, new Date())) {
                logger.debug(`[HybridWeatherController] Skipping update for ${cityId} from ${payload.model} (Arbitration Logic)`);
                continue;
            }

            // Update arbitration state
            this.cityUpdateStates.set(cityId, {
                lastUpdateSource: payload.model === 'ECMWF' || payload.model === 'GFS' ? payload.model : 'OTHER',
                lastUpdateTimestamp: new Date(),
                // payload.timestamp is usually creation time, we want run time if possible, but timestamp is close enough for now
                lastModelRunTime: payload.timestamp 
            });

            this.fileConfirmedCities.add(cityId);
            
            // Store with high confidence from S3 file
            this.storeDataWithConfidence(cityId, 'S3_FILE', cityData.temperatureF, 1.0);
            
            // Store in data store
            const marketId = this.dataStore.getAllMarkets().find(m => 
                m.city?.toLowerCase().replace(/\s+/g, '_') === cityId
            )?.market.id;
            
            if (marketId) {
                this.dataStore.reconcileForecast(marketId, cityData, payload.model, payload.cycleHour, payload.forecastHour);
            }
            
            // Emit forecast change event to trigger trading opportunity re-scan
            // This ensures the bot immediately re-evaluates markets when new file data arrives
            this.eventBus.emit({
                type: 'FORECAST_CHANGED',
                payload: {
                    cityId,
                    provider: payload.model,
                    newValue: cityData.temperatureF,
                    changeAmount: 1.0, // Significant change to trigger re-scan
                    timestamp: new Date(),
                    source: 'S3_FILE' as DataSourceType,
                    confidence: 1.0,
                },
            });
            
            logger.debug(`[HybridWeatherController] Emitted FORECAST_CHANGED for ${cityId} from ${payload.model} file`);
        }
        
        this.emit('fileConfirmed', payload);
    }

    /**
     * Determines if a new forecast should be applied based on arbitration rules.
     * 
     * Rules:
     * 1. Race: Whichever arrives first triggers update.
     * 2. ECMWF Preference: If ECMWF arrives after GFS, always update.
     * 3. GFS Restriction: If GFS arrives after ECMWF:
     *    - < 5 mins since ECMWF: IGNORE GFS.
     *    - > 1 hour since ECMWF: UPDATE with GFS (freshness wins).
     *    - 5m - 1h: IGNORE (Implicitly prefer ECMWF).
     */
    private shouldUpdateForecast(
        cityId: string, 
        newModel: ModelType, 
        newTimestamp: Date // Current wall-clock time
    ): boolean {
        const currentState = this.cityUpdateStates.get(cityId);

        // Rule 1: First arrival (no previous state) -> Update
        if (!currentState) {
            return true;
        }

        // Rule 2: ECMWF Preference
        // If the new update is ECMWF, we generally always accept it.
        if (newModel === 'ECMWF') {
            return true; 
        }

        // Rule 3: GFS Handling
        if (newModel === 'GFS') {
            // If previous was also GFS, update (newer GFS replaces older GFS)
            if (currentState.lastUpdateSource === 'GFS') {
                return true;
            }

            // If previous was ECMWF, check time diff
            if (currentState.lastUpdateSource === 'ECMWF') {
                const timeSinceLastUpdateMs = newTimestamp.getTime() - currentState.lastUpdateTimestamp.getTime();
                const timeSinceLastUpdateMinutes = timeSinceLastUpdateMs / (1000 * 60);

                // "Short time" (< 5 mins) -> Ignore
                if (timeSinceLastUpdateMinutes < 5) {
                    logger.info(`Ignoring GFS update for ${cityId}: Too close to ECMWF update (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
                    return false;
                }

                // "Long time" (> 1 hour) -> Update
                if (timeSinceLastUpdateMinutes > 60) {
                     logger.info(`Accepting GFS update for ${cityId}: Significantly fresher than ECMWF (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
                    return true;
                }

                // Implicit: 5m - 60m -> Ignore (Stick with preferred ECMWF)
                logger.info(`Ignoring GFS update for ${cityId}: Within ECMWF preference window (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
                return false;
            }
        }

        // Default: Allow update (e.g. from other sources if we support them)
        return true;
    }

    /**
     * Update historical learning data with actual publication time
     */
    private updateHistoricalData(model: ModelType, cycleHour: number, detectionLatencyMs: number): void {
        const key = `${model}_${cycleHour}`;
        const data = this.historicalData.get(key);
        
        if (data) {
            // Convert latency to offset (approximate)
            const actualOffset = data.expectedOffsetMinutes + (detectionLatencyMs / 60000);
            data.actualOffsets.push(actualOffset);
            
            // Keep last 20 observations
            if (data.actualOffsets.length > 20) {
                data.actualOffsets.shift();
            }
            
            // Recalculate statistics
            const sum = data.actualOffsets.reduce((a, b) => a + b, 0);
            data.averageOffset = sum / data.actualOffsets.length;
            
            const variance = data.actualOffsets.reduce((sum, val) => {
                return sum + Math.pow(val - data.averageOffset, 2);
            }, 0) / data.actualOffsets.length;
            data.stdDevOffset = Math.sqrt(variance);
            
            // Update reliability score (lower std dev = higher reliability)
            data.reliabilityScore = Math.max(0, 1 - (data.stdDevOffset / 10));
            data.lastUpdated = new Date();
            
            logger.debug(`[HistoricalLearning] ${model} ${cycleHour}Z: avg=${data.averageOffset.toFixed(1)}min, std=${data.stdDevOffset.toFixed(1)}min, reliability=${(data.reliabilityScore * 100).toFixed(0)}%`);
        }
    }

    /**
     * Store data with confidence scoring
     */
    private storeDataWithConfidence(
        cityId: string,
        source: DataSourceType,
        value: number,
        baseConfidence: number
    ): void {
        const priority = DATA_SOURCE_PRIORITIES[source];
        const timestamp = new Date();
        
        // Calculate freshness multiplier
        const stalenessMs = 0;  // Fresh data
        const freshnessMultiplier = 1.0;
        
        // Calculate reconciliation bonus (agreement with other sources)
        const reconciliationBonus = this.calculateReconciliationBonus(cityId, source, value);
        
        // Calculate final confidence score
        const finalScore = baseConfidence * priority.confidenceWeight * freshnessMultiplier + reconciliationBonus;
        
        // Store in cache
        if (!this.sourceDataCache.has(cityId)) {
            this.sourceDataCache.set(cityId, new Map());
        }
        
        this.sourceDataCache.get(cityId)!.set(source, {
            value,
            timestamp,
            confidence: finalScore
        });
        
        // Check for early detection trigger
        if (finalScore >= EARLY_DETECTION_CONFIG.triggerThreshold && !this.earlyDetectionActive) {
            this.triggerEarlyDetection({
                model: 'HRRR',  // Default, will be updated
                cycleHour: new Date().getUTCHours(),
                triggeredAt: new Date(),
                triggerSource: source,
                confidence: finalScore
            });
        }
    }

    /**
     * Calculate reconciliation bonus when sources agree
     */
    private calculateReconciliationBonus(cityId: string, source: DataSourceType, value: number): number {
        const cityData = this.sourceDataCache.get(cityId);
        if (!cityData) return 0;
        
        let bonus = 0;
        const threshold = 0.5;  // Temperature threshold for agreement
        
        for (const [otherSource, data] of cityData.entries()) {
            if (otherSource !== source) {
                const diff = Math.abs(data.value - value);
                if (diff < threshold) {
                    // Sources agree - add bonus based on other source's priority
                    bonus += DATA_SOURCE_PRIORITIES[otherSource].priority * 0.01;
                }
            }
        }
        
        return Math.min(bonus, 0.2);  // Cap bonus at 0.2
    }

    /**
     * Reconcile data from multiple sources
     */
    reconcileSources(cityId: string): ReconciliationResult | null {
        const cityData = this.sourceDataCache.get(cityId);
        if (!cityData || cityData.size === 0) return null;
        
        const sources: Array<{
            source: DataSourceType;
            value: number;
            confidence: number;
            timestamp: Date;
        }> = [];
        
        // Gather all sources
        for (const [source, data] of cityData.entries()) {
            // Check staleness
            const stalenessMs = Date.now() - data.timestamp.getTime();
            const maxStaleness = DATA_SOURCE_PRIORITIES[source].maxStalenessMs;
            
            if (stalenessMs <= maxStaleness) {
                // Apply freshness penalty
                const freshnessMultiplier = Math.exp(-stalenessMs / maxStaleness);
                const adjustedConfidence = data.confidence * freshnessMultiplier;
                
                sources.push({
                    source,
                    value: data.value,
                    confidence: adjustedConfidence,
                    timestamp: data.timestamp
                });
            }
        }
        
        if (sources.length === 0) return null;
        
        // Sort by confidence (highest first)
        sources.sort((a, b) => b.confidence - a.confidence);
        
        // Calculate disagreement
        const values = sources.map(s => s.value);
        const maxDiff = Math.max(...values) - Math.min(...values);
        
        const result: ReconciliationResult = {
            marketId: cityId,  // Will be mapped to actual market ID
            selectedSource: sources[0].source,
            selectedValue: sources[0].value,
            allSources: sources,
            disagreementAmount: maxDiff,
            resolutionReason: maxDiff < 0.5 
                ? 'Sources agree within threshold' 
                : `Selected highest confidence source (${sources[0].source})`
        };
        
        this.state.lastReconciliationResult = result;
        return result;
    }

    /**
     * Trigger early detection mode
     */
    private triggerEarlyDetection(trigger: EarlyDetectionTrigger): void {
        if (this.earlyDetectionActive) return;
        
        logger.info(`🚨 Early detection triggered by ${trigger.triggerSource} (confidence: ${(trigger.confidence * 100).toFixed(0)}%)`);
        
        this.earlyDetectionActive = true;
        this.earlyDetectionStartTime = new Date();
        
        // Transition to early detection mode
        this.transitionTo('EARLY_DETECTION', 'early_detection_triggered');
        
        // Set timeout to exit early detection
        this.earlyDetectionTimeoutId = setTimeout(() => {
            this.exitEarlyDetection();
        }, EARLY_DETECTION_CONFIG.maxDurationMs);
        
        this.emit('earlyDetectionTriggered', trigger);
    }

    /**
     * Exit early detection mode
     */
    private exitEarlyDetection(): void {
        if (!this.earlyDetectionActive) return;
        
        logger.info('✅ Early detection completed');
        
        this.earlyDetectionActive = false;
        this.earlyDetectionStartTime = null;
        
        if (this.earlyDetectionTimeoutId) {
            clearTimeout(this.earlyDetectionTimeoutId);
            this.earlyDetectionTimeoutId = null;
        }
        
        // Return to appropriate mode
        if (this.state.currentDetectionWindow) {
            this.transitionTo('DETECTION_POLLING', 'early_detection_complete');
        } else {
            this.transitionTo('WEBSOCKET_IDLE', 'early_detection_complete');
        }
        
        this.emit('earlyDetectionComplete');
    }

    /**
     * Setup event listeners for integration with other components
     */
    private setupEventListeners(): void {
        // Listen for webhook triggers from Tomorrow.io
        this.eventBus.on('FORECAST_TRIGGER', async (event) => {
            const payload = event.payload as { provider: 'tomorrow.io'; cityId: string; triggerTimestamp: Date; location: Coordinates; forecastId?: string; updateType?: string };
            if (payload.provider === 'tomorrow.io') {
                await this.handleWebhookTrigger(payload.cityId, payload.location);
            }
        });

        // Listen for forecast changes detected via WebSocket
        this.eventBus.on('FORECAST_CHANGED', (event) => {
            const payload = event.payload as {
                cityId: string;
                marketId?: string;
                provider: string;
                previousValue?: number;
                newValue: number;
                changeAmount: number; 
                timestamp: Date;
                source?: DataSourceType;
                confidence?: number;
            };
            
            // Store with confidence if provided
            if (payload.source && payload.confidence !== undefined) {
                this.storeDataWithConfidence(payload.cityId, payload.source, payload.newValue, payload.confidence);
            }
            
            // Only trigger burst if we're in WEBSOCKET_IDLE mode (not in detection window)
            if (this.state.currentMode === 'WEBSOCKET_IDLE' && payload.provider === 'tomorrow.io') {
                this.handleWebSocketForecastChange(payload.cityId, payload.changeAmount);
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

        // Start file-based ingestion if enabled
        if (this.fileBasedIngestionEnabled && this.fileBasedIngestion) {
            this.fileBasedIngestion.start();
            logger.info('📁 File-based ingestion started');
        }

        // Start detection window checker (every 30 seconds for precise timing)
        this.detectionWindowCheckIntervalId = setInterval(() => {
            this.checkDetectionWindows();
        }, 30000);

        // Initial check
        this.checkDetectionWindows();

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

        // Stop polling if active
        this.stopPolling();

        // Exit early detection if active
        this.exitEarlyDetection();

        // Stop file-based ingestion
        if (this.fileBasedIngestion) {
            this.fileBasedIngestion.stop();
        }

        // Dispose confirmation manager
        if (this.confirmationManager) {
            this.confirmationManager.dispose();
        }

        logger.info('HybridWeatherController stopped');
        this.emit('stopped', { timestamp: new Date() });
    }

    /**
     * Clear all active timers
     */
    private clearAllTimers(): void {
        if (this.detectionWindowCheckIntervalId) {
            clearInterval(this.detectionWindowCheckIntervalId);
            this.detectionWindowCheckIntervalId = null;
        }
        if (this.burstIntervalId) {
            clearInterval(this.burstIntervalId);
            this.burstIntervalId = null;
        }
        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = null;
        }
        if (this.burstTimeoutId) {
            clearTimeout(this.burstTimeoutId);
            this.burstTimeoutId = null;
        }
        if (this.earlyDetectionTimeoutId) {
            clearTimeout(this.earlyDetectionTimeoutId);
            this.earlyDetectionTimeoutId = null;
        }
    }

    /**
     * Check if we're currently in any detection window
     * Uses adaptive windows based on historical learning
     */
    private checkDetectionWindows(): void {
        if (!this.state.isAutoMode) {
            logger.debug('Skipping detection window check - manual mode active');
            return;
        }

        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const currentTimeMinutes = utcHour * 60 + utcMinute;

        // Check each detection window config with adaptive adjustments
        for (const config of DETECTION_WINDOW_CONFIGS) {
            // Get adaptive window if historical data exists
            const adaptiveWindow = this.getAdaptiveWindow(config, utcHour);
            
            // Calculate which cycle we're in
            const cyclesSinceMidnight = Math.floor(currentTimeMinutes / (config.cycleIntervalHours * 60));
            const cycleStartMinutes = cyclesSinceMidnight * config.cycleIntervalHours * 60;
            
            const windowStartMinutes = cycleStartMinutes + adaptiveWindow.adjustedStartOffset;
            const windowEndMinutes = cycleStartMinutes + adaptiveWindow.adjustedEndOffset;

            // Check if we're in this detection window
            if (currentTimeMinutes >= windowStartMinutes && currentTimeMinutes < windowEndMinutes) {
                const cycleHour = Math.floor(cycleStartMinutes / 60) % 24;
                
                // Check if this is a new window (different from current)
                if (!this.state.currentDetectionWindow || 
                    this.state.currentDetectionWindow.model !== config.model ||
                    this.state.currentDetectionWindow.cycleHour !== cycleHour) {
                    
                    // New detection window started
                    this.enterDetectionWindow(config.model, cycleHour, windowStartMinutes, windowEndMinutes);
                }
                return; // We're in a window, no need to check others
            }
        }

        // Not in any detection window
        if (this.state.currentMode === 'DETECTION_POLLING') {
            this.exitDetectionWindow();
        }
    }

    /**
     * Get adaptive detection window based on historical learning
     */
    private getAdaptiveWindow(config: DetectionWindowConfig, currentHour: number): {
        adjustedStartOffset: number;
        adjustedEndOffset: number;
        confidence: number;
    } {
        const cycleHour = Math.floor(currentHour / config.cycleIntervalHours) * config.cycleIntervalHours;
        const key = `${config.model}_${cycleHour}`;
        const historicalData = this.historicalData.get(key);
        
        if (!historicalData || historicalData.actualOffsets.length < 5) {
            // Not enough historical data, use defaults
            return {
                adjustedStartOffset: config.startOffsetMinutes,
                adjustedEndOffset: config.endOffsetMinutes,
                confidence: 0.5
            };
        }
        
        // Adjust window based on historical data
        // Start slightly earlier than average to catch early publications
        const adjustedStart = Math.max(0, historicalData.averageOffset - historicalData.stdDevOffset - 2);
        const adjustedEnd = historicalData.averageOffset + historicalData.stdDevOffset + 5;
        
        return {
            adjustedStartOffset: adjustedStart,
            adjustedEndOffset: adjustedEnd,
            confidence: historicalData.reliabilityScore
        };
    }

    /**
     * Enter detection window polling mode
     */
    private enterDetectionWindow(model: ModelType, cycleHour: number, windowStartMinutes: number, windowEndMinutes: number): void {
        const now = new Date();
        const windowStart = new Date(now);
        windowStart.setUTCMinutes(windowStartMinutes % 60);
        windowStart.setUTCHours(Math.floor(windowStartMinutes / 60));
        
        const windowEnd = new Date(now);
        windowEnd.setUTCMinutes(windowEndMinutes % 60);
        windowEnd.setUTCHours(Math.floor(windowEndMinutes / 60));

        this.state.currentDetectionWindow = {
            model,
            cycleHour,
            windowStart,
            windowEnd,
        };

        logger.info(`🔍 Detection window started: ${model} ${String(cycleHour).padStart(2, '0')}Z (${windowStartMinutes}-${windowEndMinutes} min)`);

        this.transitionTo('DETECTION_POLLING', 'detection_window_started');
    }

    /**
     * Exit detection window
     */
    private exitDetectionWindow(): void {
        logger.info(`🔍 Detection window ended`);
        this.state.currentDetectionWindow = null;
        this.transitionTo('WEBSOCKET_IDLE', 'detection_window_ended');
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
            case 'DETECTION_POLLING':
                this.stopPolling();
                break;
            case 'WEBSOCKET_IDLE':
                // Nothing to clean up
                break;
            case 'BURST_MODE':
                this.stopBurstMode();
                break;
            case 'EARLY_DETECTION':
                // Early detection cleanup handled separately
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
            forecastChanges: 0,
            webhooksReceived: 0,
        };
        this.state.modeHistory.push(stats);
    }

    /**
     * Enter a new mode
     */
    private async enterNewMode(mode: HybridWeatherMode, cityId?: string): Promise<void> {
        switch (mode) {
            case 'DETECTION_POLLING':
                this.startPolling();
                break;
            case 'WEBSOCKET_IDLE':
                // No polling, just WebSocket listening
                logger.info('🔌 Entering WEBSOCKET_IDLE mode (NO polling)');
                break;
            case 'BURST_MODE':
                this.startBurstMode(cityId);
                break;
            case 'EARLY_DETECTION':
                this.startEarlyDetectionPolling();
                break;
        }
    }

    /**
     * Start early detection polling (faster interval)
     */
    private startEarlyDetectionPolling(): void {
        logger.info('🚨 Starting early detection polling (every 1s)');
        this.pollingActive = true;

        // Execute first poll immediately
        this.executePoll();

        // Set up interval (1 second for early detection)
        this.pollIntervalId = setInterval(() => {
            this.executePoll();
        }, EARLY_DETECTION_CONFIG.pollIntervalMs);
    }

    // ====================
    // DETECTION POLLING Mode
    // ====================

    /**
     * Start polling during detection window
     */
    private startPolling(): void {
        if (this.pollingActive) {
            return;
        }

        logger.info('📡 Starting detection window polling (every 2s)');
        this.pollingActive = true;

        // Execute first poll immediately
        this.executePoll();

        // Set up interval (2 seconds as requested)
        this.pollIntervalId = setInterval(() => {
            this.executePoll();
        }, 2000);
    }

    /**
     * Stop polling
     */
    private stopPolling(): void {
        if (!this.pollingActive) {
            return;
        }

        logger.info('📡 Stopping detection window polling');
        this.pollingActive = false;

        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = null;
        }
    }

    /**
     * Execute a single poll using Open-Meteo with MeteoSource fallback
     */
    private async executePoll(): Promise<void> {
        if (!this.pollingActive) {
            return;
        }

        // Check if Open-Meteo quota exceeded
        if (this.apiTracker.isQuotaExceeded('openmeteo')) {
            logger.warn('Open-Meteo quota exceeded, falling back to MeteoSource');
            await this.executeMeteoSourcePoll();
            return;
        }

        // Get active cities (exclude file-confirmed cities and FETCH_MODE cities)
        let cities: string[] = [];
        for (const cityId of this.state.activeCities) {
            if (!this.fileConfirmedCities.has(cityId) && !this.stateMachine.isInFetchMode(cityId)) {
                cities.push(cityId);
            }
        }
        
        if (cities.length === 0) {
            // No active cities, poll all known cities from dataStore
            const allMarkets = this.dataStore.getAllMarkets();
            const citySet = new Set<string>();
            for (const market of allMarkets) {
                if (market.city) {
                    const cityId = this.fastNormalizeCityId(market.city);
                    if (!this.fileConfirmedCities.has(cityId) && !this.stateMachine.isInFetchMode(cityId)) {
                        citySet.add(cityId);
                    }
                }
            }
            cities = Array.from(citySet);
        }

        if (cities.length === 0) {
            logger.debug('No cities to poll');
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
            return;
        }

        try {
            // Try Open-Meteo first
            const openMeteoProvider = this.providerManager.getProvider('openmeteo');
            
            if (!('getHourlyForecastBatch' in openMeteoProvider)) {
                logger.error('OpenMeteo provider does not support batch requests');
                await this.executeMeteoSourcePoll();
                return;
            }

            const openMeteoClient = openMeteoProvider as import('../weather/openmeteo-client.js').OpenMeteoClient;

            const locations = cityLocations.map(({ city }) => ({
                coords: city.coordinates,
                locationName: city.name
            }));

            logger.debug(`🌤️ Open-Meteo batch request: ${locations.length} cities`);

            // Execute batch request (no cache during detection window)
            const batchResults = await openMeteoClient.getHourlyForecastBatch(locations, false);

            // Record API call
            this.apiTracker.recordCall('openmeteo', true);

            // Process results
            this.processBatchResults(batchResults, cityLocations, 'open-meteo');

        } catch (error) {
            logger.error('Open-Meteo poll failed, falling back to MeteoSource', {
                error: (error as Error).message,
            });
            
            // Record failed call
            this.apiTracker.recordCall('openmeteo', false);
            
            // Fallback to MeteoSource
            await this.executeMeteoSourcePoll();
        }
    }

    /**
     * Execute poll using MeteoSource (fallback)
     */
    private async executeMeteoSourcePoll(): Promise<void> {
        const meteosourceProvider = this.providerManager.getProvider('meteosource');
        if (!meteosourceProvider) {
            logger.warn('MeteoSource provider not available');
            return;
        }

        // Get cities (same logic as executePoll)
        let cities: string[] = [];
        for (const cityId of this.state.activeCities) {
            if (!this.fileConfirmedCities.has(cityId) && !this.stateMachine.isInFetchMode(cityId)) {
                cities.push(cityId);
            }
        }
        
        if (cities.length === 0) {
            const allMarkets = this.dataStore.getAllMarkets();
            const citySet = new Set<string>();
            for (const market of allMarkets) {
                if (market.city) {
                    const cityId = this.fastNormalizeCityId(market.city);
                    if (!this.fileConfirmedCities.has(cityId) && !this.stateMachine.isInFetchMode(cityId)) {
                        citySet.add(cityId);
                    }
                }
            }
            cities = Array.from(citySet);
        }

        const cityLocations: Array<{ cityId: string; city: CityLocation }> = [];
        for (const cityId of cities) {
            const city = findCity(cityId);
            if (city) {
                cityLocations.push({ cityId, city });
            }
        }

        if (cityLocations.length === 0) {
            return;
        }

        try {
            if (!('getHourlyForecastBatch' in meteosourceProvider)) {
                logger.error('MeteoSource provider does not support batch requests');
                return;
            }

            const meteosourceClient = meteosourceProvider as import('../weather/additional-providers.js').MeteosourceProvider;

            const locations = cityLocations.map(({ city }) => ({
                coords: city.coordinates,
                locationName: city.name
            }));

            logger.debug(`🌤️ MeteoSource batch request: ${locations.length} cities`);

            const batchResults = await meteosourceClient.getHourlyForecastBatch(locations, false);

            // Record API calls
            for (let i = 0; i < batchResults.length; i++) {
                this.apiTracker.recordCall('meteosource', true);
            }

            this.processBatchResults(batchResults, cityLocations, 'meteosource');

        } catch (error) {
            logger.error('MeteoSource poll failed', {
                error: (error as Error).message,
            });
            
            for (let i = 0; i < cityLocations.length; i++) {
                this.apiTracker.recordCall('meteosource', false);
            }
        }
    }

    /**
     * Process batch poll results
     */
    private processBatchResults(
        batchResults: import('../weather/types.js').WeatherData[],
        cityLocations: Array<{ cityId: string; city: CityLocation }>,
        provider: string
    ): void {
        const batchForecasts: Array<{
            cityId: string;
            cityName: string;
            temperatureC: number;
            temperatureF: number;
            windSpeedMph: number;
            precipitationMm: number;
            timestamp: Date;
            source: DataSourceType;
            confidence: number;
        }> = [];

        for (let i = 0; i < batchResults.length && i < cityLocations.length; i++) {
            const result = batchResults[i];
            const { cityId, city } = cityLocations[i];

            const currentForecast = result.hourly[0];
            if (!currentForecast) continue;

            // Calculate confidence score for API data
            const confidence = this.calculateDataConfidence('API', new Date());

            const forecastData = {
                cityId,
                cityName: city.name,
                temperatureC: currentForecast.temperatureC,
                temperatureF: currentForecast.temperatureF,
                windSpeedMph: currentForecast.windSpeedMph || 0,
                precipitationMm: currentForecast.snowfallInches ? currentForecast.snowfallInches * 25.4 : 0,
                timestamp: new Date(),
                source: 'API' as DataSourceType,
                confidence,
            };

            // Store in shared cache
            this.forecastCache.set(cityId, {
                data: forecastData,
                expiresAt: new Date(Date.now() + this.FORECAST_CACHE_TTL_MS),
            });

            // Store with confidence scoring
            this.storeDataWithConfidence(cityId, 'API', forecastData.temperatureF, confidence);

            batchForecasts.push(forecastData);

            // Emit events
            this.eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider,
                    success: true,
                    hasChanges: true,
                },
            });

            this.eventBus.emit({
                type: 'FORECAST_UPDATED',
                payload: {
                    cityId,
                    cityName: city.name,
                    provider,
                    temperatureC: forecastData.temperatureC,
                    temperatureF: forecastData.temperatureF,
                    windSpeedMph: forecastData.windSpeedMph,
                    precipitationMm: forecastData.precipitationMm,
                    timestamp: forecastData.timestamp,
                    source: 'API' as DataSourceType,
                    confidence,
                },
            });
        }

        // Emit batch update event
        if (batchForecasts.length > 0) {
            this.lastBatchUpdateTime = new Date();
            this.eventBus.emit({
                type: 'FORECAST_BATCH_UPDATED',
                payload: {
                    forecasts: batchForecasts,
                    provider,
                    batchTimestamp: this.lastBatchUpdateTime,
                    totalCities: batchForecasts.length,
                },
            });
        }
    }

    /**
     * Calculate confidence score for data based on source and freshness
     */
    private calculateDataConfidence(source: DataSourceType, timestamp: Date): number {
        const priority = DATA_SOURCE_PRIORITIES[source];
        const stalenessMs = Date.now() - timestamp.getTime();
        
        // Calculate freshness multiplier
        const freshnessMultiplier = Math.max(0, 1 - (stalenessMs / priority.maxStalenessMs));
        
        // Base confidence from source priority
        return priority.confidenceWeight * freshnessMultiplier;
    }

    // ====================
    // BURST MODE
    // ====================

    /**
     * Start burst mode (triggered by WebSocket alert)
     */
    private startBurstMode(cityId?: string): void {
        if (this.burstModeActive) {
            // Already in burst mode, extend it
            logger.info('⚡ Extending burst mode');
            this.resetBurstTimeout();
            return;
        }

        logger.info('⚡ Entering BURST_MODE', { 
            cityId,
            duration: '60 seconds',
            rate: '1 req/2 sec',
        });
        
        this.burstModeActive = true;
        this.burstRequestCount = 0;
        this.burstStartTime = new Date();
        this.state.burstStartTime = new Date();
        this.state.burstRequestsCompleted = 0;

        // Notify API tracker
        this.apiTracker.enterBurstMode();

        // Start burst polling
        this.startBurstPolling();

        // Set timeout to end burst after 60 seconds
        this.burstTimeoutId = setTimeout(() => {
            this.handleBurstComplete();
        }, BURST_CONFIG.durationMs);

        this.emit('modeEntered', { mode: 'BURST_MODE', cityId });
    }

    /**
     * Reset burst timeout (extend burst)
     */
    private resetBurstTimeout(): void {
        if (this.burstTimeoutId) {
            clearTimeout(this.burstTimeoutId);
        }
        this.burstTimeoutId = setTimeout(() => {
            this.handleBurstComplete();
        }, BURST_CONFIG.durationMs);
    }

    /**
     * Start burst polling
     */
    private startBurstPolling(): void {
        // Execute first poll immediately
        this.executeBurstPoll();
        
        // Set up interval (2 seconds)
        this.burstIntervalId = setInterval(() => {
            this.executeBurstPoll();
        }, BURST_CONFIG.intervalMs);
    }

    /**
     * Stop burst mode
     */
    private stopBurstMode(): void {
        this.burstModeActive = false;
        
        if (this.burstIntervalId) {
            clearInterval(this.burstIntervalId);
            this.burstIntervalId = null;
        }
        
        if (this.burstTimeoutId) {
            clearTimeout(this.burstTimeoutId);
            this.burstTimeoutId = null;
        }

        // Notify API tracker
        this.apiTracker.exitBurstMode();
    }

    /**
     * Execute a single burst poll
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

        // Execute poll (same as detection polling)
        await this.executePoll();

        this.burstRequestCount++;
        this.state.burstRequestsCompleted++;
        
        logger.debug(`Burst poll: ${this.burstRequestCount}/30`);
    }

    /**
     * Handle burst completion
     */
    private async handleBurstComplete(): Promise<void> {
        logger.info('✅ Burst mode completed', {
            totalRequests: this.burstRequestCount,
            duration: '60 seconds',
        });

        this.stopBurstMode();

        // Return to appropriate mode
        if (this.state.currentDetectionWindow) {
            await this.transitionTo('DETECTION_POLLING', 'burst_complete');
        } else {
            await this.transitionTo('WEBSOCKET_IDLE', 'burst_complete');
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
        this.state.activeCities.add(cityId);
    }

    /**
     * Handle forecast change detected via WebSocket
     * Triggers burst mode when in WEBSOCKET_IDLE
     */
    private async handleWebSocketForecastChange(cityId: string, changeAmount: number): Promise<void> {
        const significantChangeThreshold = 2.0; // degrees or percentage points

        if (Math.abs(changeAmount) >= significantChangeThreshold &&
            this.state.currentMode === 'WEBSOCKET_IDLE') {
            
            logger.info(`📊 Significant forecast change via WebSocket: ${changeAmount} for ${cityId}`);

            // Trigger burst mode
            await this.transitionTo('BURST_MODE', 'webhook_trigger', cityId);
        }
    }

    // ====================
    // Public API
    // ====================

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
     * Get current detection window info
     */
    public getCurrentDetectionWindow(): HybridControllerState['currentDetectionWindow'] {
        return this.state.currentDetectionWindow;
    }

    /**
     * Trigger manual burst mode for a specific city
     */
    public async triggerBurstMode(cityId: string): Promise<void> {
        logger.info(`🚀 Manual burst mode triggered for ${cityId}`);
        await this.transitionTo('BURST_MODE', 'manual', cityId);
    }

    /**
     * Return to auto mode
     */
    public async returnToAutoMode(): Promise<void> {
        logger.info('⏮️ Returning to auto mode');
        this.state.isAutoMode = true;
        
        // Check current detection window status
        this.checkDetectionWindows();
    }

    /**
     * Force transition to a specific mode (disables auto mode)
     */
    public async forceMode(mode: HybridWeatherMode, reason: string = 'manual'): Promise<void> {
        logger.warn(`🚨 Force mode transition to ${mode}`, { reason });
        
        this.state.isAutoMode = false;
        logger.info('🚫 Auto mode disabled - manual mode active');
        
        await this.transitionTo(mode, reason as ModeTransitionReason);
    }

    /**
     * Get reconciliation result for a city
     */
    public getReconciliationResult(cityId: string): ReconciliationResult | null {
        return this.reconcileSources(cityId);
    }

    /**
     * Get historical learning data for a model
     */
    public getHistoricalData(model: ModelType, cycleHour: number): HistoricalPublicationData | undefined {
        const key = `${model}_${cycleHour}`;
        return this.historicalData.get(key);
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
        pollingActive: boolean;
        earlyDetectionActive: boolean;
        burstProgress: { elapsedMs: number; requestsCompleted: number; totalRequests: number } | null;
        nextDetectionWindow: { model: ModelType; timeUntil: string } | null;
        isAutoMode: boolean;
        cacheStats: { size: number };
        fileBasedIngestion: {
            enabled: boolean;
            fileConfirmedCities: number;
        };
        dataSourceStats: {
            cachedCities: number;
            reconciliationReady: number;
        };
        historicalLearning: {
            modelsTracked: number;
            averageReliability: number;
        };
    } {
        // Calculate burst progress if active
        let burstProgress = null;
        if (this.burstModeActive && this.burstStartTime) {
            const elapsedMs = Date.now() - this.burstStartTime.getTime();
            burstProgress = {
                elapsedMs,
                requestsCompleted: this.burstRequestCount,
                totalRequests: 30, // 60 seconds / 2 second interval
            };
        }

        // Calculate next detection window
        const nextWindow = this.getNextDetectionWindow();
        
        // Calculate data source stats
        let reconciliationReady = 0;
        for (const [cityId, sources] of this.sourceDataCache.entries()) {
            if (sources.size >= 2) reconciliationReady++;
        }
        
        // Calculate historical learning stats
        let totalReliability = 0;
        for (const data of this.historicalData.values()) {
            totalReliability += data.reliabilityScore;
        }
        const avgReliability = this.historicalData.size > 0 
            ? totalReliability / this.historicalData.size 
            : 0;

        return {
            state: this.getState(),
            modeConfig: this.getCurrentModeConfig(),
            modeDuration: this.getCurrentModeDuration(),
            apiStatus: this.apiTracker.getStatusReport(),
            burstActive: this.burstModeActive,
            pollingActive: this.pollingActive,
            earlyDetectionActive: this.earlyDetectionActive,
            burstProgress,
            nextDetectionWindow: nextWindow,
            isAutoMode: this.state.isAutoMode,
            cacheStats: { size: this.forecastCache.size },
            fileBasedIngestion: {
                enabled: this.fileBasedIngestionEnabled,
                fileConfirmedCities: this.fileConfirmedCities.size,
            },
            dataSourceStats: {
                cachedCities: this.sourceDataCache.size,
                reconciliationReady,
            },
            historicalLearning: {
                modelsTracked: this.historicalData.size,
                averageReliability: parseFloat(avgReliability.toFixed(2)),
            }
        };
    }

    /**
     * Get next detection window information
     */
    private getNextDetectionWindow(): { model: ModelType; timeUntil: string } | null {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinute = now.getUTCMinutes();
        const currentTimeMinutes = utcHour * 60 + utcMinute;

        let nextWindow: { model: ModelType; startMinutes: number } | null = null;
        let minTimeDiff = Infinity;

        for (const config of DETECTION_WINDOW_CONFIGS) {
            const cyclesSinceMidnight = Math.floor(currentTimeMinutes / (config.cycleIntervalHours * 60));
            const cycleStartMinutes = cyclesSinceMidnight * config.cycleIntervalHours * 60;
            const windowStartMinutes = cycleStartMinutes + config.startOffsetMinutes;

            let timeDiff = windowStartMinutes - currentTimeMinutes;
            
            // If window already passed today, check next cycle
            if (timeDiff < 0) {
                timeDiff += config.cycleIntervalHours * 60;
            }

            if (timeDiff < minTimeDiff) {
                minTimeDiff = timeDiff;
                nextWindow = { model: config.model, startMinutes: windowStartMinutes };
            }
        }

        if (!nextWindow) return null;

        const hours = Math.floor(minTimeDiff / 60);
        const minutes = minTimeDiff % 60;
        const timeUntil = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

        return {
            model: nextWindow.model,
            timeUntil,
        };
    }

    /**
     * Get cached forecast for a specific city
     */
    public getCachedForecast(cityId: string): {
        cityId: string;
        cityName: string;
        temperatureC: number;
        temperatureF: number;
        windSpeedMph: number;
        precipitationMm: number;
        timestamp: Date;
        source: DataSourceType;
        confidence: number;
    } | null {
        const cached = this.forecastCache.get(cityId);
        if (!cached) {
            return null;
        }

        if (cached.expiresAt.getTime() < Date.now()) {
            this.forecastCache.delete(cityId);
            return null;
        }

        return cached.data;
    }

    /**
     * Get all cached forecasts
     */
    public getAllCachedForecasts(): Array<{
        cityId: string;
        cityName: string;
        temperatureC: number;
        temperatureF: number;
        windSpeedMph: number;
        precipitationMm: number;
        timestamp: Date;
        source: DataSourceType;
        confidence: number;
    }> {
        const now = Date.now();
        const results: Array<{
            cityId: string;
            cityName: string;
            temperatureC: number;
            temperatureF: number;
            windSpeedMph: number;
            precipitationMm: number;
            timestamp: Date;
            source: DataSourceType;
            confidence: number;
        }> = [];

        for (const [cityId, entry] of this.forecastCache.entries()) {
            if (entry.expiresAt.getTime() >= now) {
                results.push(entry.data);
            } else {
                this.forecastCache.delete(cityId);
            }
        }

        return results;
    }
}

export default HybridWeatherController;
