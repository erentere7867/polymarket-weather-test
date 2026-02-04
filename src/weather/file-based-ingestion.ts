/**
 * File-Based Ingestion Controller
 * Coordinates ScheduleManager, S3FileDetector, and GRIB2Parser
 * Manages detection windows and polling lifecycle
 */

import { EventEmitter } from 'events';
import { ScheduleManager } from './schedule-manager.js';
import { S3FileDetector } from './s3-file-detector.js';
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
    s3PollIntervalMs: 150,
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
    private eventBus: EventBus;
    private isRunning: boolean = false;
    private unsubscribers: (() => void)[] = [];

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
     * Handle detection window start event
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
        
        // Start S3 detection
        this.s3Detector.startDetection(expectedFile, schedule);
        
        this.emit('detectionStarted', {
            model: payload.model,
            cycleHour: payload.cycleHour,
            expectedFile,
        });
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