/**
 * Confirmation Manager
 * Coordinates file-based and API-based data streams
 * Tracks confirmation state per model/cycle
 * Reconciles API data when file confirmation arrives
 */

import { EventEmitter } from 'events';
import { EventBus } from '../realtime/event-bus.js';
import { logger } from '../logger.js';
import { ModelType, CityGRIBData, FileConfirmedData } from './types.js';
import { config } from '../config.js';

/**
 * Confirmation status for a forecast
 */
export type ConfirmationStatus = 'PENDING' | 'UNCONFIRMED' | 'CONFIRMED';

/**
 * Pending API data waiting for reconciliation
 */
interface PendingApiData {
    cityId: string;
    cityName: string;
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    temperatureC: number;
    windSpeedMph: number;
    precipitationMm: number;
    timestamp: Date;
}

/**
 * Confirmation state for a model/cycle
 */
interface ConfirmationState {
    model: ModelType;
    cycleHour: number;
    status: ConfirmationStatus;
    pendingApiData: Map<string, PendingApiData>; // cityId -> data
    fileData: Map<string, CityGRIBData>; // cityId -> data
    detectionWindowStart: Date;
    confirmedAt?: Date;
}

/**
 * Cross-model confirmation between RAP and HRRR
 * Used when speed arb mode is OFF to require HRRR confirmation of RAP data
 */
export interface RapHrrrConfirmation {
    cycleHour: number;
    runDate: string; // YYYY-MM-DD
    rapData: Map<string, CityGRIBData>;  // cityId -> data
    hrrrData: Map<string, CityGRIBData>; // cityId -> data
    confirmedAt: Date;
    // Track which cities have confirmed data (HRRR within tolerance of RAP)
    confirmedCities: Set<string>;
    // Temperature differences per city for debugging
    temperatureDifferences: Map<string, number>; // cityId -> |temp_RAP - temp_HRRR| in °F
}

/**
 * Configuration for confirmation manager
 */
export interface ConfirmationManagerConfig {
    /** Maximum time to wait for file confirmation (minutes) */
    maxWaitMinutes: number;
    /** Whether to emit events for unconfirmed data */
    emitUnconfirmed: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ConfirmationManagerConfig = {
    maxWaitMinutes: 5,
    emitUnconfirmed: true, // Emit API data immediately, reconcile later
};

/**
 * Confirmation Manager
 * Manages the coordination between file-based and API-based data streams
 */
export class ConfirmationManager extends EventEmitter {
    private config: ConfirmationManagerConfig;
    private eventBus: EventBus;
    private states: Map<string, ConfirmationState> = new Map(); // windowId -> state
    private unsubscribers: (() => void)[] = [];
    
    /**
     * Cross-model confirmations between RAP and HRRR
     * Key format: "YYYY-MM-DD-HHZ" (runDate-cycleHour)
     */
    private rapHrrrConfirmations: Map<string, RapHrrrConfirmation> = new Map();
    
    /**
     * Store RAP data for later HRRR confirmation
     * Key format: "YYYY-MM-DD-HHZ"
     */
    private pendingRapData: Map<string, Map<string, CityGRIBData>> = new Map();

    constructor(configOverride: Partial<ConfirmationManagerConfig> = {}) {
        super();
        this.config = {
            maxWaitMinutes:
                config.API_FALLBACK_MAX_DURATION_MINUTES ??
                DEFAULT_CONFIG.maxWaitMinutes,
            emitUnconfirmed: configOverride.emitUnconfirmed ?? DEFAULT_CONFIG.emitUnconfirmed,
        };
        this.eventBus = EventBus.getInstance();
        this.setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    private setupEventListeners(): void {
        // Listen for FILE_CONFIRMED events
        const unsubConfirmed = this.eventBus.on('FILE_CONFIRMED', (event) => {
            if (event.type === 'FILE_CONFIRMED') {
                this.handleFileConfirmed(event.payload);
            }
        });
        this.unsubscribers.push(unsubConfirmed);

        // Listen for API_DATA_RECEIVED events
        const unsubApiData = this.eventBus.on('API_DATA_RECEIVED', (event) => {
            if (event.type === 'API_DATA_RECEIVED') {
                this.handleApiDataReceived(event.payload);
            }
        });
        this.unsubscribers.push(unsubApiData);

        // Listen for DETECTION_WINDOW_START
        const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
            if (event.type === 'DETECTION_WINDOW_START') {
                this.handleDetectionWindowStart(event.payload);
            }
        });
        this.unsubscribers.push(unsubWindowStart);
    }

    /**
     * Handle detection window start
     */
    private handleDetectionWindowStart(payload: {
        model: ModelType;
        cycleHour: number;
        runDate: Date;
        windowStart: Date;
    }): void {
        const windowId = this.getWindowId(payload.model, payload.cycleHour);

        // Create new confirmation state
        const state: ConfirmationState = {
            model: payload.model,
            cycleHour: payload.cycleHour,
            status: 'PENDING',
            pendingApiData: new Map(),
            fileData: new Map(),
            detectionWindowStart: payload.windowStart,
        };

        this.states.set(windowId, state);

        logger.info(
            `[ConfirmationManager] Detection window started for ${windowId}`
        );

        // Set timeout to transition to UNCONFIRMED if no file arrives
        setTimeout(() => {
            this.handleMaxWaitReached(windowId);
        }, this.config.maxWaitMinutes * 60 * 1000);

        this.emit('windowStarted', { windowId, state });
    }

    /**
     * Handle API data received
     */
    private handleApiDataReceived(payload: {
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
    }): void {
        const windowId = this.getWindowId(payload.model, payload.cycleHour);
        const state = this.states.get(windowId);

        if (!state) {
            // No active window for this data
            logger.debug(
                `[ConfirmationManager] API data received for inactive window ${windowId}`
            );
            return;
        }

        // Store pending API data
        const pendingData: PendingApiData = {
            cityId: payload.cityId,
            cityName: payload.cityName,
            model: payload.model,
            cycleHour: payload.cycleHour,
            forecastHour: payload.forecastHour,
            temperatureC: payload.temperatureC,
            windSpeedMph: payload.windSpeedMph,
            precipitationMm: payload.precipitationMm,
            timestamp: payload.timestamp,
        };

        state.pendingApiData.set(payload.cityId, pendingData);

        // If still pending, emit event for unconfirmed data
        if (state.status === 'PENDING' && this.config.emitUnconfirmed) {
            this.emit('unconfirmedDataReceived', {
                windowId,
                cityId: payload.cityId,
                data: pendingData,
            });
        }

        // Update status to UNCONFIRMED if this is first API data
        if (state.status === 'PENDING') {
            state.status = 'UNCONFIRMED';
            logger.info(
                `[ConfirmationManager] Status changed to UNCONFIRMED for ${windowId}`
            );
            this.emit('statusChanged', { windowId, status: 'UNCONFIRMED', state });
        }
    }

    /**
     * Handle file confirmed event
     */
    private handleFileConfirmed(payload: Omit<FileConfirmedData, 'runDate'>): void {
        const windowId = this.getWindowId(payload.model, payload.cycleHour);
        const state = this.states.get(windowId);

        if (!state) {
            logger.warn(
                `[ConfirmationManager] File confirmed for unknown window ${windowId}`
            );
            return;
        }

        // Update status
        state.status = 'CONFIRMED';
        state.confirmedAt = new Date();

        // Store file data
        for (const cityData of payload.cityData) {
            const cityId = cityData.cityName.toLowerCase().replace(/\s+/g, '_');
            state.fileData.set(cityId, cityData);
        }

        logger.info(
            `[ConfirmationManager] File confirmed for ${windowId} ` +
            `(${payload.cityData.length} cities, ${payload.detectionLatencyMs}ms latency)`
        );

        // Reconcile with pending API data
        const reconciliations = this.reconcileData(state);

        this.emit('fileConfirmed', {
            windowId,
            state,
            cityData: payload.cityData,
            reconciliations,
        });

        this.emit('statusChanged', { windowId, status: 'CONFIRMED', state });
    }

    /**
     * Handle max wait time reached without file confirmation
     */
    private handleMaxWaitReached(windowId: string): void {
        const state = this.states.get(windowId);
        if (!state) return;

        // If still pending/unconfirmed, mark as permanently unconfirmed
        if (state.status !== 'CONFIRMED') {
            logger.warn(
                `[ConfirmationManager] Max wait reached for ${windowId}, ` +
                `data remains ${state.status}`
            );
            this.emit('maxWaitReached', { windowId, state });
        }
    }

    /**
     * Reconcile API data with file data
     */
    private reconcileData(state: ConfirmationState): Array<{
        cityId: string;
        apiValue: number;
        fileValue: number;
        difference: number;
        variable: string;
    }> {
        const reconciliations: Array<{
            cityId: string;
            apiValue: number;
            fileValue: number;
            difference: number;
            variable: string;
        }> = [];

        for (const [cityId, apiData] of state.pendingApiData.entries()) {
            const fileData = state.fileData.get(cityId);
            if (!fileData) continue;

            // Compare temperature
            const tempDiff = Math.abs(apiData.temperatureC - fileData.temperatureC);
            if (tempDiff > 0.1) {
                reconciliations.push({
                    cityId,
                    apiValue: apiData.temperatureC,
                    fileValue: fileData.temperatureC,
                    difference: tempDiff,
                    variable: 'temperature',
                });
            }

            // Compare wind speed
            const apiWindKph = apiData.windSpeedMph * 1.60934;
            const fileWindKph = fileData.windSpeedMps * 3.6;
            const windDiff = Math.abs(apiWindKph - fileWindKph);
            if (windDiff > 1) {
                reconciliations.push({
                    cityId,
                    apiValue: apiWindKph,
                    fileValue: fileWindKph,
                    difference: windDiff,
                    variable: 'windSpeed',
                });
            }

            // Compare precipitation
            const precipDiff = Math.abs(apiData.precipitationMm - fileData.totalPrecipitationMm);
            if (precipDiff > 0.1) {
                reconciliations.push({
                    cityId,
                    apiValue: apiData.precipitationMm,
                    fileValue: fileData.totalPrecipitationMm,
                    difference: precipDiff,
                    variable: 'precipitation',
                });
            }
        }

        if (reconciliations.length > 0) {
            logger.info(
                `[ConfirmationManager] Reconciled ${reconciliations.length} differences ` +
                `for ${this.getWindowId(state.model, state.cycleHour)}`
            );
        }

        return reconciliations;
    }

    /**
     * Get confirmation state for a window
     */
    public getState(windowId: string): ConfirmationState | undefined {
        return this.states.get(windowId);
    }

    /**
     * Get all active states
     */
    public getAllStates(): ConfirmationState[] {
        return Array.from(this.states.values());
    }

    /**
     * Get status summary
     */
    public getStatusSummary(): {
        total: number;
        pending: number;
        unconfirmed: number;
        confirmed: number;
    } {
        let pending = 0;
        let unconfirmed = 0;
        let confirmed = 0;

        for (const state of this.states.values()) {
            switch (state.status) {
                case 'PENDING':
                    pending++;
                    break;
                case 'UNCONFIRMED':
                    unconfirmed++;
                    break;
                case 'CONFIRMED':
                    confirmed++;
                    break;
            }
        }

        return {
            total: this.states.size,
            pending,
            unconfirmed,
            confirmed,
        };
    }

    /**
     * Clean up old states
     */
    public cleanupOldStates(maxAgeHours: number = 24): void {
        const now = new Date();
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        for (const [windowId, state] of this.states.entries()) {
            const age = now.getTime() - state.detectionWindowStart.getTime();
            if (age > maxAgeMs) {
                this.states.delete(windowId);
                logger.debug(`[ConfirmationManager] Cleaned up old state ${windowId}`);
            }
        }
        
        // Also clean up old RAP-HRRR confirmations
        for (const [key, confirmation] of this.rapHrrrConfirmations.entries()) {
            const age = now.getTime() - confirmation.confirmedAt.getTime();
            if (age > maxAgeMs) {
                this.rapHrrrConfirmations.delete(key);
                logger.debug(`[ConfirmationManager] Cleaned up old RAP-HRRR confirmation ${key}`);
            }
        }
        
        // Clean up pending RAP data
        for (const [key] of this.pendingRapData.entries()) {
            // Parse the date from the key and check age
            const parts = key.split('-');
            if (parts.length >= 3) {
                const dateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
                const keyDate = new Date(dateStr + 'T00:00:00Z');
                const age = now.getTime() - keyDate.getTime();
                if (age > maxAgeMs) {
                    this.pendingRapData.delete(key);
                    logger.debug(`[ConfirmationManager] Cleaned up pending RAP data for ${key}`);
                }
            }
        }
    }
    
    // ========================================
    // RAP-HRRR Cross-Model Confirmation Methods
    // ========================================
    
    /**
     * Store RAP data for later HRRR confirmation
     * Called when RAP file is confirmed
     */
    public storeRapData(cycleHour: number, runDate: Date, cityData: CityGRIBData[]): void {
        const key = this.getRapHrrrKey(cycleHour, runDate);
        const cityMap = new Map<string, CityGRIBData>();
        
        for (const city of cityData) {
            const cityId = city.cityName.toLowerCase().replace(/\s+/g, '_');
            cityMap.set(cityId, city);
        }
        
        this.pendingRapData.set(key, cityMap);
        logger.info(
            `[ConfirmationManager] Stored RAP data for ${key} (${cityData.length} cities)`
        );
    }
    
    /**
     * Create RAP-HRRR confirmation when HRRR data arrives
     * Compares HRRR data with stored RAP data and marks cities as confirmed if within tolerance
     */
    public createRapHrrrConfirmation(
        cycleHour: number,
        runDate: Date,
        hrrrCityData: CityGRIBData[]
    ): RapHrrrConfirmation | null {
        const key = this.getRapHrrrKey(cycleHour, runDate);
        const rapData = this.pendingRapData.get(key);
        
        if (!rapData) {
            logger.debug(
                `[ConfirmationManager] No RAP data found for ${key}, cannot create confirmation`
            );
            return null;
        }
        
        const hrrrData = new Map<string, CityGRIBData>();
        const confirmedCities = new Set<string>();
        const temperatureDifferences = new Map<string, number>();
        const tolerance = config.RAP_HRRR_TEMP_TOLERANCE;
        
        // Store HRRR data and compare with RAP
        for (const city of hrrrCityData) {
            const cityId = city.cityName.toLowerCase().replace(/\s+/g, '_');
            hrrrData.set(cityId, city);
            
            const rapCity = rapData.get(cityId);
            if (rapCity) {
                // Compare temperatures (both in Fahrenheit for consistency)
                const tempDiff = Math.abs(rapCity.temperatureF - city.temperatureF);
                temperatureDifferences.set(cityId, tempDiff);
                
                if (tempDiff <= tolerance) {
                    confirmedCities.add(cityId);
                    logger.debug(
                        `[ConfirmationManager] City ${cityId} confirmed: ` +
                        `RAP=${rapCity.temperatureF.toFixed(1)}°F, ` +
                        `HRRR=${city.temperatureF.toFixed(1)}°F, ` +
                        `diff=${tempDiff.toFixed(2)}°F (tolerance=${tolerance}°F)`
                    );
                } else {
                    logger.info(
                        `[ConfirmationManager] City ${cityId} NOT confirmed: ` +
                        `RAP=${rapCity.temperatureF.toFixed(1)}°F, ` +
                        `HRRR=${city.temperatureF.toFixed(1)}°F, ` +
                        `diff=${tempDiff.toFixed(2)}°F > tolerance=${tolerance}°F`
                    );
                }
            }
        }
        
        const confirmation: RapHrrrConfirmation = {
            cycleHour,
            runDate: this.formatRunDate(runDate),
            rapData,
            hrrrData,
            confirmedAt: new Date(),
            confirmedCities,
            temperatureDifferences,
        };
        
        this.rapHrrrConfirmations.set(key, confirmation);
        
        logger.info(
            `[ConfirmationManager] RAP-HRRR confirmation created for ${key}: ` +
            `${confirmedCities.size}/${hrrrCityData.length} cities confirmed`
        );
        
        // Emit event for system-wide notification
        this.eventBus.emit({
            type: 'RAP_HRRR_CONFIRMED',
            payload: {
                cycleHour,
                runDate: this.formatRunDate(runDate),
                confirmedAt: confirmation.confirmedAt,
                confirmedCities: Array.from(confirmedCities),
                temperatureDifferences,
            },
        });
        
        return confirmation;
    }
    
    /**
     * Check if a specific city has RAP-HRRR confirmation
     * Used by trading logic when speed arb mode is OFF
     */
    public checkRapHrrrConfirmation(
        cityId: string,
        cycleHour: number,
        runDate: Date | string
    ): boolean {
        const runDateStr = typeof runDate === 'string' ? runDate : this.formatRunDate(runDate);
        const key = this.getRapHrrrKey(cycleHour, new Date(runDateStr + 'T00:00:00Z'));
        const confirmation = this.rapHrrrConfirmations.get(key);
        
        if (!confirmation) {
            return false;
        }
        
        // Normalize cityId for lookup
        const normalizedCityId = cityId.toLowerCase().replace(/\s+/g, '_');
        return confirmation.confirmedCities.has(normalizedCityId);
    }
    
    /**
     * Get RAP-HRRR confirmation for a specific cycle
     */
    public getRapHrrrConfirmation(cycleHour: number, runDate: Date | string): RapHrrrConfirmation | null {
        const runDateStr = typeof runDate === 'string' ? runDate : this.formatRunDate(runDate);
        const key = this.getRapHrrrKey(cycleHour, new Date(runDateStr + 'T00:00:00Z'));
        return this.rapHrrrConfirmations.get(key) ?? null;
    }
    
    /**
     * Get all RAP-HRRR confirmations
     */
    public getAllRapHrrrConfirmations(): RapHrrrConfirmation[] {
        return Array.from(this.rapHrrrConfirmations.values());
    }
    
    /**
     * Generate key for RAP-HRRR confirmations
     * Format: "YYYY-MM-DD-HHZ"
     */
    private getRapHrrrKey(cycleHour: number, runDate: Date): string {
        return `${this.formatRunDate(runDate)}-${String(cycleHour).padStart(2, '0')}Z`;
    }
    
    /**
     * Format run date as YYYY-MM-DD string
     */
    private formatRunDate(date: Date): string {
        return date.toISOString().split('T')[0];
    }

    /**
     * Dispose of the manager
     */
    public dispose(): void {
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

export default ConfirmationManager;
