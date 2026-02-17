/**
 * File-Based Ingestion Controller
 * Coordinates ScheduleManager, S3FileDetector, and GRIB2Parser
 * Manages detection windows and polling lifecycle
 */

import { EventEmitter } from 'events';
import { ScheduleManager } from './schedule-manager.js';
import { S3FileDetector } from './s3-file-detector.js';
import { ConfirmationManager } from './confirmation-manager.js';
import {
    ModelType,
    DetectionWindow,
    ExpectedFileInfo,
    ModelRunSchedule,
    FileConfirmedData,
    CityModelConfig,
    CITY_MODEL_CONFIGS,
} from './types.js';
import { EventBus } from '../realtime/event-bus.js';
import { logger } from '../logger.js';

/**
 * File-Based Ingestion Configuration
 */
export interface FileBasedIngestionConfig {
    /** Enable/disable file-based ingestion */
    enabled: boolean;
    /** S3 poll interval in milliseconds */
    s3PollIntervalMs: number;
    /** Maximum detection duration in milliseconds */
    maxDetectionDurationMs: number;
    /** AWS region */
    awsRegion: string;
    /** Whether to use public S3 buckets (no auth) */
    publicBuckets: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: FileBasedIngestionConfig = {
    enabled: true,
    s3PollIntervalMs: 50, // OPTIMIZED: 50ms (was 150ms)
    maxDetectionDurationMs: 45 * 60 * 1000, // 45 minutes
    awsRegion: 'us-east-1',
    publicBuckets: true,
};

/**
 * File-Based Ingestion Controller
 * Main entry point for NOAA S3 file detection system
 */
export class FileBasedIngestion extends EventEmitter {
    private config: FileBasedIngestionConfig;
    private scheduleManager: ScheduleManager;
    private s3Detector: S3FileDetector;
    private confirmationManager: ConfirmationManager;
    private eventBus: EventBus;
    private isRunning: boolean = false;
    private unsubscribers: (() => void)[] = [];
    
    /**
     * Pending HRRR windows waiting for RAP confirmation
     * Key format: "YYYY-MM-DD-HHZ" (date + cycle hour)
     * Value: The detection window that's queued for later processing
     */
    private pendingHrrrWindows: Map<string, DetectionWindow> = new Map();

    constructor(config: Partial<FileBasedIngestionConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = EventBus.getInstance();
        
        // Initialize components
        this.scheduleManager = new ScheduleManager();
        this.s3Detector = new S3FileDetector({
            pollIntervalMs: this.config.s3PollIntervalMs,
            maxDetectionDurationMs: this.config.maxDetectionDurationMs,
            region: this.config.awsRegion,
            publicBuckets: this.config.publicBuckets,
        });
        this.confirmationManager = new ConfirmationManager();
    }

    /**
     * Start the file-based ingestion system
     */
    public start(): void {
        if (this.isRunning) {
            logger.warn('[FileBasedIngestion] Already running');
            return;
        }
        
        if (!this.config.enabled) {
            logger.info('[FileBasedIngestion] Disabled, not starting');
            return;
        }
        
        logger.info('[FileBasedIngestion] Starting file-based ingestion system');
        this.isRunning = true;
        
        // Subscribe to detection window start events
        const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
            if (event.type === 'DETECTION_WINDOW_START') {
                this.handleDetectionWindowStart(event.payload);
            }
        });
        this.unsubscribers.push(unsubWindowStart);
        
        // Subscribe to RAP_CONFIRMED events to trigger pending HRRR detection
        const unsubRapConfirmed = this.eventBus.on('RAP_CONFIRMED', (event) => {
            if (event.type === 'RAP_CONFIRMED') {
                this.handleRapConfirmed(event.payload);
            }
        });
        this.unsubscribers.push(unsubRapConfirmed);
        
        // Subscribe to local S3 detector events instead of global event bus
        // This prevents infinite loops and ensures we only handle our own detections
        this.s3Detector.on('detected', (result) => {
            this.handleFileDetected({
                model: result.expectedFile.model,
                cycleHour: result.expectedFile.cycleHour,
                forecastHour: result.expectedFile.forecastHour,
                bucket: result.expectedFile.bucket,
                key: result.expectedFile.key,
                detectedAt: result.detectedAt,
                detectionLatencyMs: result.detectionLatencyMs,
                fileSize: result.fileSize,
                lastModified: result.lastModified,
            });
        });

        this.s3Detector.on('confirmed', (data) => {
            this.handleFileConfirmed({
                model: data.result.expectedFile.model,
                cycleHour: data.result.expectedFile.cycleHour,
                forecastHour: data.result.expectedFile.forecastHour,
                cityData: data.data.cityData,
                timestamp: new Date(),
                source: 'FILE',
                detectionLatencyMs: data.result.detectionLatencyMs,
                downloadTimeMs: data.downloadTimeMs,
                parseTimeMs: data.parseTimeMs,
                fileSize: data.result.fileSize,
            });
        });
        
        // Pre-warm S3 clients (fire-and-forget to avoid blocking startup)
        this.s3Detector.warmup().catch(err => {
            logger.warn(`[FileBasedIngestion] S3 warmup failed (non-fatal): ${err}`);
        });
        
        // Start schedule manager
        this.scheduleManager.start();
        
        // Log initial upcoming runs
        const upcomingRuns = this.scheduleManager.getUpcomingRuns(10);
        logger.info(`[FileBasedIngestion] Monitoring ${upcomingRuns.length} upcoming model runs`);
        
        this.emit('started');
    }

    /**
     * Stop the file-based ingestion system
     */
    public stop(): void {
        if (!this.isRunning) {
            return;
        }
        
        logger.info('[FileBasedIngestion] Stopping file-based ingestion system');
        this.isRunning = false;
        
        // Unsubscribe from events
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        
        // Stop components
        this.scheduleManager.stop();
        this.s3Detector.stopAll();
        
        this.emit('stopped');
    }

    /**
     * Check if the system is running
     */
    public getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get active detection windows
     */
    public getActiveWindows(): DetectionWindow[] {
        return this.scheduleManager.getActiveWindows();
    }

    /**
     * Get number of active S3 detections
     */
    public getActiveDetectionCount(): number {
        return this.s3Detector.getActiveDetectionCount();
    }

    /**
     * Get upcoming model runs
     */
    public getUpcomingRuns(count: number): ModelRunSchedule[] {
        return this.scheduleManager.getUpcomingRuns(count);
    }

    /**
     * Manually trigger detection for a specific model cycle
     * Useful for testing or catching up on missed cycles
     */
    public async triggerManualDetection(
        model: ModelType,
        cycleHour: number,
        runDate: Date = new Date()
    ): Promise<void> {
        logger.info(`[FileBasedIngestion] Manual detection triggered for ${model} ${String(cycleHour).padStart(2, '0')}Z`);
        
        const expectedFile = this.scheduleManager.getExpectedFile(model, cycleHour, runDate);
        const schedule = this.scheduleManager.calculateDetectionWindow(model, cycleHour, runDate);
        
        // Start detection immediately
        this.s3Detector.startDetection(expectedFile, schedule);
    }

    /**
     * Get city model configuration
     */
    public getCityModelConfig(cityName: string): CityModelConfig | undefined {
        return CITY_MODEL_CONFIGS.find(c => c.cityName.toLowerCase() === cityName.toLowerCase());
    }

    /**
     * Get all city model configurations
     */
    public getAllCityModelConfigs(): CityModelConfig[] {
        return CITY_MODEL_CONFIGS;
    }
    
    /**
     * Get the confirmation manager for RAP-HRRR cross-model confirmation
     */
    public getConfirmationManager(): ConfirmationManager {
        return this.confirmationManager;
    }

    /**
     * Handle detection window start event
     * For HRRR: Check if RAP is confirmed for the same cycle hour
     * If RAP not confirmed, queue HRRR for later processing
     */
    private handleDetectionWindowStart(payload: {
        model: ModelType;
        cycleHour: number;
        runDate: Date;
        windowStart: Date;
        expectedFile: {
            bucket: string;
            key: string;
            fullUrl: string;
        };
    }): void {
        logger.info(
            `[FileBasedIngestion] Detection window started: ${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z`
        );
        
        // Get full expected file info
        const expectedFile = this.scheduleManager.getExpectedFile(
            payload.model,
            payload.cycleHour,
            payload.runDate
        );
        
        // Get schedule for this cycle
        const schedule = this.scheduleManager.calculateDetectionWindow(
            payload.model,
            payload.cycleHour,
            payload.runDate
        );
        
        // SEQUENTIAL FETCHING LOGIC:
        // HRRR must wait for RAP confirmation before starting detection
        // This only applies to US models (RAP and HRRR are US-only)
        if (payload.model === 'HRRR') {
            const isRapConfirmed = this.scheduleManager.isRapConfirmed(payload.cycleHour, payload.runDate);
            
            if (!isRapConfirmed) {
                // Queue HRRR for later - RAP not yet confirmed
                const pendingKey = this.getPendingHrrrKey(payload.cycleHour, payload.runDate);
                
                logger.info(
                    `[FileBasedIngestion] HRRR ${String(payload.cycleHour).padStart(2, '0')}Z queued - ` +
                    `waiting for RAP confirmation (key: ${pendingKey})`
                );
                
                // Store the window info for later processing
                this.pendingHrrrWindows.set(pendingKey, {
                    model: payload.model,
                    cycleHour: payload.cycleHour,
                    runDate: payload.runDate,
                    windowStart: payload.windowStart,
                    windowEnd: schedule.detectionWindowEnd,
                    expectedFile,
                    status: 'ACTIVE',
                    createdAt: new Date(),
                });
                
                this.emit('hrrrQueued', {
                    cycleHour: payload.cycleHour,
                    runDate: payload.runDate,
                    reason: 'RAP_NOT_CONFIRMED',
                });
                
                return; // Don't start detection yet
            }
            
            logger.info(
                `[FileBasedIngestion] HRRR ${String(payload.cycleHour).padStart(2, '0')}Z proceeding - ` +
                `RAP already confirmed`
            );
        }
        
        // Start S3 detection
        this.s3Detector.startDetection(expectedFile, schedule);
        
        this.emit('detectionStarted', {
            model: payload.model,
            cycleHour: payload.cycleHour,
            expectedFile,
        });
    }
    
    /**
     * Handle RAP confirmed event
     * Triggers any pending HRRR detection for the same cycle hour
     */
    private handleRapConfirmed(payload: {
        cycleHour: number;
        runDate: Date;
        confirmedAt: Date;
    }): void {
        logger.info(
            `[FileBasedIngestion] RAP confirmed for ${String(payload.cycleHour).padStart(2, '0')}Z - ` +
            `checking for pending HRRR`
        );
        
        // Update ScheduleManager's RAP confirmation status
        this.scheduleManager.setRapConfirmed(payload.cycleHour, payload.runDate);
        
        // Check for pending HRRR window
        const pendingKey = this.getPendingHrrrKey(payload.cycleHour, payload.runDate);
        const pendingWindow = this.pendingHrrrWindows.get(pendingKey);
        
        if (pendingWindow) {
            logger.info(
                `[FileBasedIngestion] Triggering queued HRRR ${String(payload.cycleHour).padStart(2, '0')}Z ` +
                `after RAP confirmation`
            );
            
            // Remove from pending queue
            this.pendingHrrrWindows.delete(pendingKey);
            
            // Get schedule for this cycle
            const schedule = this.scheduleManager.calculateDetectionWindow(
                pendingWindow.model,
                pendingWindow.cycleHour,
                pendingWindow.runDate
            );
            
            // Start S3 detection for HRRR
            this.s3Detector.startDetection(pendingWindow.expectedFile, schedule);
            
            this.emit('hrrrTriggered', {
                cycleHour: pendingWindow.cycleHour,
                runDate: pendingWindow.runDate,
                rapConfirmedAt: payload.confirmedAt,
            });
            
            this.emit('detectionStarted', {
                model: pendingWindow.model,
                cycleHour: pendingWindow.cycleHour,
                expectedFile: pendingWindow.expectedFile,
            });
        } else {
            logger.debug(
                `[FileBasedIngestion] No pending HRRR for ${String(payload.cycleHour).padStart(2, '0')}Z`
            );
        }
    }
    
    /**
     * Generate key for pending HRRR windows
     * Format: "YYYY-MM-DD-HHZ"
     */
    private getPendingHrrrKey(cycleHour: number, runDate: Date): string {
        const year = runDate.getUTCFullYear();
        const month = String(runDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(runDate.getUTCDate()).padStart(2, '0');
        const hh = String(cycleHour).padStart(2, '0');
        return `${year}-${month}-${day}-${hh}Z`;
    }
    
    /**
     * Calculate the run date for a given cycle hour
     * This ensures consistent date calculation across the confirmation flow
     *
     * For cycles that haven't happened yet today (e.g., 18Z at 12Z), use today's date
     * For cycles that already happened today (e.g., 00Z at 06Z), use today's date
     * For late-night cycles (e.g., 23Z) being confirmed early morning (e.g., 01Z next day),
     * we need to use yesterday's date
     *
     * @param cycleHour The cycle hour (0-23)
     * @returns The run date for the cycle
     */
    private calculateRunDate(cycleHour: number): Date {
        const now = new Date();
        const currentHour = now.getUTCHours();
        
        let runDate: Date;
        
        // If current UTC hour is less than cycle hour, the cycle belongs to yesterday
        // This handles: 01:00 UTC confirming 23:00Z cycle from yesterday
        // Also handles: 06:00 UTC confirming 00:00Z cycle from today
        if (currentHour < cycleHour) {
            // Cycle hasn't happened yet today, use yesterday's date
            const yesterday = new Date(now);
            yesterday.setUTCDate(yesterday.getUTCDate() - 1);
            runDate = new Date(Date.UTC(
                yesterday.getUTCFullYear(),
                yesterday.getUTCMonth(),
                yesterday.getUTCDate(),
                0, 0, 0, 0
            ));
        } else {
            // Cycle has happened today (or is happening now), use today's date
            runDate = new Date(Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                0, 0, 0, 0
            ));
        }
        
        return runDate;
    }

    /**
     * Handle file detected event
     */
    private handleFileDetected(payload: {
        model: ModelType;
        cycleHour: number;
        forecastHour: number;
        bucket: string;
        key: string;
        detectedAt: Date;
        detectionLatencyMs: number;
        fileSize: number;
        lastModified: Date;
    }): void {
        logger.info(
            `[FileBasedIngestion] File detected: ${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z ` +
            `(${payload.detectionLatencyMs}ms latency)`
        );
        
        // Update window status
        const windowKey = this.getWindowKey(payload.model, payload.cycleHour);
        this.scheduleManager.updateWindowStatus(windowKey, 'DETECTED');
        
        this.emit('fileDetected', payload);
    }

    /**
     * Handle file confirmed event (downloaded and parsed)
     * For RAP: Emit RAP_CONFIRMED event to trigger pending HRRR detection
     */
    private handleFileConfirmed(payload: {
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
    }): void {
        const totalLatencyMs = payload.detectionLatencyMs + payload.downloadTimeMs + payload.parseTimeMs;
        
        logger.info(
            `[FileBasedIngestion] File confirmed: ${payload.model} ${String(payload.cycleHour).padStart(2, '0')}Z ` +
            `(total latency: ${totalLatencyMs}ms, parsed ${payload.cityData.length} cities)`
        );
        
        // Update window status
        const windowKey = this.getWindowKey(payload.model, payload.cycleHour);
        this.scheduleManager.updateWindowStatus(windowKey, 'CONFIRMED');
        
        // Log per-city data
        for (const city of payload.cityData) {
            logger.debug(
                `[FileBasedIngestion] ${city.cityName}: ${city.temperatureF.toFixed(1)}°F, ` +
                `${city.windSpeedMph.toFixed(1)}mph, ${city.totalPrecipitationIn.toFixed(2)}in precip`
            );
        }
        
        this.emit('fileConfirmed', payload);
        this.emit('forecastUpdated', {
            model: payload.model,
            cycleHour: payload.cycleHour,
            cityData: payload.cityData,
            totalLatencyMs,
        });
        
        // Emit to EventBus for system-wide notification
        // This ensures forecast changes trigger opportunity re-scans
        this.eventBus.emit({
            type: 'FILE_CONFIRMED',
            payload: {
                model: payload.model,
                cycleHour: payload.cycleHour,
                forecastHour: payload.forecastHour,
                cityData: payload.cityData,
                timestamp: new Date(),
                source: 'FILE',
                detectionLatencyMs: payload.detectionLatencyMs,
                downloadTimeMs: payload.downloadTimeMs,
                parseTimeMs: payload.parseTimeMs,
                fileSize: payload.fileSize,
            },
        });
        
        logger.debug(`[FileBasedIngestion] Emitted FILE_CONFIRMED to EventBus`);
        
        // SEQUENTIAL FETCHING: Emit RAP_CONFIRMED event when RAP is confirmed
        // This will trigger any pending HRRR detection for the same cycle hour
        if (payload.model === 'RAP') {
            // Use consistent runDate calculation to match pending HRRR window keys
            const runDate = this.calculateRunDate(payload.cycleHour);
            logger.info(
                `[FileBasedIngestion] RAP confirmed for ${String(payload.cycleHour).padStart(2, '0')}Z - ` +
                `emitting RAP_CONFIRMED event (runDate: ${runDate.toISOString().split('T')[0]})`
            );
            
            // Store RAP data for later HRRR confirmation
            this.confirmationManager.storeRapData(payload.cycleHour, runDate, payload.cityData);
            
            this.eventBus.emit({
                type: 'RAP_CONFIRMED',
                payload: {
                    cycleHour: payload.cycleHour,
                    runDate,
                    confirmedAt: new Date(),
                },
            });
        }
        
        // RAP-HRRR CONFIRMATION: When HRRR is confirmed, check against RAP data
        // This creates cross-model confirmation for trading logic
        if (payload.model === 'HRRR') {
            // Use consistent runDate calculation to match stored RAP data keys
            const runDate = this.calculateRunDate(payload.cycleHour);
            const confirmation = this.confirmationManager.createRapHrrrConfirmation(
                payload.cycleHour,
                runDate,
                payload.cityData
            );
            
            if (confirmation) {
                logger.info(
                    `[FileBasedIngestion] RAP-HRRR confirmation created for ` +
                    `${String(payload.cycleHour).padStart(2, '0')}Z: ` +
                    `${confirmation.confirmedCities.size}/${payload.cityData.length} cities confirmed`
                );
            } else {
                logger.debug(
                    `[FileBasedIngestion] No RAP data available for HRRR confirmation at ` +
                    `${String(payload.cycleHour).padStart(2, '0')}Z`
                );
            }
        }
    }

    /**
     * Generate window key
     */
    private getWindowKey(model: ModelType, cycleHour: number): string {
        const dateStr = new Date().toISOString().split('T')[0];
        return `${model}-${dateStr}-${String(cycleHour).padStart(2, '0')}Z`;
    }
}

export default FileBasedIngestion;