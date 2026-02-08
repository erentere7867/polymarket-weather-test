/**
 * Schedule Manager
 * Pre-computes expected filenames and manages detection windows for all NOAA models
 */

import { EventEmitter } from 'events';
import {
    ModelType,
    ModelRunSchedule,
    ExpectedFileInfo,
    ModelConfig,
    DetectionWindow,
    DetectionWindowStatus,
    CITY_MODEL_CONFIGS,
} from './types.js';
import { EventBus } from '../realtime/event-bus.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Schedule Manager configuration
 */
export interface ScheduleManagerConfig {
    /** How long before expected publication to start detection window (minutes) */
    detectionWindowLeadMinutes: number;
    /** Maximum duration of detection window (minutes) */
    detectionWindowDurationMinutes: number;
    /** When to start fallback API polling relative to expected publish time (minutes) */
    fallbackWindowLeadMinutes: number;
    /** Maximum duration of fallback window (minutes) */
    fallbackWindowDurationMinutes: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ScheduleManagerConfig = {
    detectionWindowLeadMinutes: 10,      // Start 10 min before expected publication (was 5)
    detectionWindowDurationMinutes: 45,  // Poll for 45 minutes max
    fallbackWindowLeadMinutes: 10,      // Start API fallback 10 min after expected
    fallbackWindowDurationMinutes: 30,   // Fallback for 30 minutes max
};

/**
 * Model timing configurations
 */
const MODEL_CONFIGS: Record<ModelType, ModelConfig> = {
    HRRR: {
        cycleIntervalHours: 1,
        firstFileDelayMinutes: { min: 25, max: 45 },
        detectionFile: 0,        // Check f00
        bucket: 'noaa-hrrr-bdp-pds',
        pathTemplate: 'hrrr.{YYYYMMDD}/conus/hrrr.t{HH}z.wrfsfcf{FF}.grib2',
    },
    RAP: {
        cycleIntervalHours: 1,
        firstFileDelayMinutes: { min: 25, max: 40 },
        detectionFile: 0,        // Check f00
        bucket: 'noaa-rap-pds',
        pathTemplate: 'rap.{YYYYMMDD}/rap.t{HH}z.awp130pgrbf{FF}.grib2',
    },
    GFS: {
        cycleIntervalHours: 6,
        firstFileDelayMinutes: { min: 210, max: 240 }, // 3.5 - 4 hours
        detectionFile: 3,        // Check f003 (f00 often delayed)
        bucket: 'noaa-gfs-bdp-pds',
        pathTemplate: 'gfs.{YYYYMMDD}/{HH}/atmos/gfs.t{HH}z.pgrb2.0p25.f{FFF}',
        detectionWindowDurationMinutes: 120, // Give GFS more time (2 hours)
    },
    ECMWF: {
        cycleIntervalHours: 12,
        firstFileDelayMinutes: { min: 360, max: 420 }, // 6-7 hours delay
        detectionFile: 0,
        bucket: 'ecmwf-forecasts',
        pathTemplate: '{YYYYMMDD}/{HH}z/ifs/0p25/oper/{YYYYMMDD}{HH}0000-{F}h-oper-fc.grib2',
        region: 'eu-central-1',
        detectionWindowDurationMinutes: 360, // Give ECMWF 6 hours window (sometimes late)
    },
};

/**
 * Schedule Manager
 * Pre-computes expected filenames and manages detection windows
 */
export class ScheduleManager extends EventEmitter {
    private config: ScheduleManagerConfig;
    private eventBus: EventBus;
    private activeWindows: Map<string, DetectionWindow> = new Map();
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly CHECK_INTERVAL_MS = 10000; // Check every 10 seconds for faster detection

    constructor(config: Partial<ScheduleManagerConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = EventBus.getInstance();
    }

    /**
     * Start monitoring schedules
     */
    public start(): void {
        logger.info('[ScheduleManager] Starting schedule monitoring');

        // Initial check
        this.checkAndCreateWindows();

        // Set up interval for checking upcoming windows
        this.checkInterval = setInterval(() => {
            this.checkAndCreateWindows();
        }, this.CHECK_INTERVAL_MS);
    }

    /**
     * Stop monitoring schedules
     */
    public stop(): void {
        logger.info('[ScheduleManager] Stopping schedule monitoring');

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        this.activeWindows.clear();
    }

    /**
     * Get model configuration
     */
    public getModelConfig(model: ModelType): ModelConfig {
        return MODEL_CONFIGS[model];
    }

    /**
     * Get expected file information for a model cycle
     */
    public getExpectedFile(model: ModelType, cycleHour: number, runDate: Date): ExpectedFileInfo {
        const config = MODEL_CONFIGS[model];
        const forecastHour = config.detectionFile;

        // Format date components
        const year = runDate.getUTCFullYear();
        const month = String(runDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(runDate.getUTCDate()).padStart(2, '0');
        const yyyymmdd = `${year}${month}${day}`;
        const hh = String(cycleHour).padStart(2, '0');
        const ff = String(forecastHour).padStart(2, '0');
        const fff = String(forecastHour).padStart(3, '0');
        const f = String(forecastHour); // No padding

        // Build the key using the template
        // Use regex with global flag to replace all occurrences
        let key = config.pathTemplate
            .replace(/{YYYYMMDD}/g, yyyymmdd)
            .replace(/{HH}/g, hh)
            .replace(/{FF}/g, ff)
            .replace(/{FFF}/g, fff)
            .replace(/{F}/g, f);

        const fullUrl = `https://${config.bucket}.s3.amazonaws.com/${key}`;

        return {
            bucket: config.bucket,
            key,
            model,
            cycleHour,
            forecastHour,
            region: config.region,
            fullUrl,
        };
    }

    /**
     * Calculate detection window for a model cycle
     * Includes early trigger window for aggressive pre-publication polling
     */
    public calculateDetectionWindow(
        model: ModelType,
        cycleHour: number,
        runDate: Date
    ): ModelRunSchedule {
        const modelConfig = MODEL_CONFIGS[model];

        // Expected publish time (using max delay as conservative estimate)
        // Ensure we're working with the correct date by using UTC methods
        const expectedPublishTime = new Date(Date.UTC(
            runDate.getUTCFullYear(),
            runDate.getUTCMonth(),
            runDate.getUTCDate(),
            cycleHour,
            modelConfig.firstFileDelayMinutes.min, // Use min delay for window start calculation
            0,
            0
        ));

        // EARLY TRIGGER: Start aggressive polling 2 minutes before expected publication
        const earlyTriggerStart = new Date(expectedPublishTime);
        earlyTriggerStart.setMinutes(
            earlyTriggerStart.getMinutes() - (config.EARLY_TRIGGER_MINUTES_BEFORE || 2)
        );

        // Detection window starts before expected publication
        const detectionWindowStart = new Date(expectedPublishTime);
        detectionWindowStart.setMinutes(
            detectionWindowStart.getMinutes() - this.config.detectionWindowLeadMinutes
        );

        // Detection window ends after max expected delay
        const detectionWindowEnd = new Date(expectedPublishTime);
        const duration = modelConfig.detectionWindowDurationMinutes || this.config.detectionWindowDurationMinutes;
        detectionWindowEnd.setMinutes(
            detectionWindowEnd.getMinutes() + duration
        );

        // Fallback window starts after expected publication
        const fallbackWindowStart = new Date(expectedPublishTime);
        fallbackWindowStart.setMinutes(
            fallbackWindowStart.getMinutes() + this.config.fallbackWindowLeadMinutes
        );

        // Fallback window ends after max duration
        const fallbackWindowEnd = new Date(fallbackWindowStart);
        fallbackWindowEnd.setMinutes(
            fallbackWindowEnd.getMinutes() + this.config.fallbackWindowDurationMinutes
        );

        return {
            model,
            cycleHour,
            runDate,
            expectedPublishTime,
            earlyTriggerStart,
            detectionWindowStart,
            detectionWindowEnd,
            fallbackWindowStart,
            fallbackWindowEnd,
        };
    }

    /**
     * Get next N upcoming model runs across all models
     */
    public getUpcomingRuns(count: number): ModelRunSchedule[] {
        const now = new Date();
        const schedules: ModelRunSchedule[] = [];

        // Look ahead 24 hours
        const lookAheadHours = 24;

        // Start looking back 24 hours to catch ECMWF runs that are late (they have 6-7hr delay)
        // This ensures we don't miss any runs due to their long file delays
        for (let hourOffset = -24; hourOffset < lookAheadHours; hourOffset++) {
            // Create check date using UTC to avoid timezone issues
            const checkDate = new Date(Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                now.getUTCHours() + hourOffset,
                0,
                0,
                0
            ));

            const cycleHour = checkDate.getUTCHours();

            // HRRR and RAP run every hour
            schedules.push(this.calculateDetectionWindow('HRRR', cycleHour, checkDate));
            schedules.push(this.calculateDetectionWindow('RAP', cycleHour, checkDate));

            // GFS runs at 00Z, 06Z, 12Z, 18Z
            if (cycleHour % 6 === 0) {
                schedules.push(this.calculateDetectionWindow('GFS', cycleHour, checkDate));
            }

            // ECMWF runs at 00Z, 12Z
            if (cycleHour % 12 === 0) {
                schedules.push(this.calculateDetectionWindow('ECMWF', cycleHour, checkDate));
            }
        }

        // Filter to future OR active windows and sort by start time
        // We want windows that haven't ended yet
        const filtered = schedules
            .filter(s => s.detectionWindowEnd > now)
            .sort((a, b) => a.detectionWindowStart.getTime() - b.detectionWindowStart.getTime())
            .slice(0, count);

        // Log what we're returning for debugging
        const gfsRuns = filtered.filter(s => s.model === 'GFS');
        const ecmwfRuns = filtered.filter(s => s.model === 'ECMWF');

        if (gfsRuns.length > 0) {
            logger.debug(`[ScheduleManager] GFS upcoming: ${gfsRuns.map(r => `${r.cycleHour}Z@${r.expectedPublishTime.toISOString()}`).join(', ')}`);
        }
        if (ecmwfRuns.length > 0) {
            logger.debug(`[ScheduleManager] ECMWF upcoming: ${ecmwfRuns.map(r => `${r.cycleHour}Z@${r.expectedPublishTime.toISOString()}`).join(', ')}`);
        }

        return filtered;
    }

    /**
     * Get active detection windows
     */
    public getActiveWindows(): DetectionWindow[] {
        return Array.from(this.activeWindows.values());
    }

    /**
     * Get window by key
     */
    public getWindow(key: string): DetectionWindow | undefined {
        return this.activeWindows.get(key);
    }

    /**
     * Update window status
     */
    public updateWindowStatus(key: string, status: DetectionWindowStatus): void {
        const window = this.activeWindows.get(key);
        if (window) {
            window.status = status;
            this.activeWindows.set(key, window);
        }
    }

    /**
     * Get cities that use a specific model as primary
     */
    public getCitiesForModel(model: ModelType): string[] {
        return CITY_MODEL_CONFIGS
            .filter(c => c.primaryModel === model)
            .map(c => c.cityName);
    }

    /**
     * Check for upcoming detection windows and create them
     */
    private checkAndCreateWindows(): void {
        const now = new Date();
        const upcomingRuns = this.getUpcomingRuns(20); // Get next 20 runs

        logger.info(`[ScheduleManager] Checking for detection windows at ${now.toISOString()}`);

        for (const run of upcomingRuns) {
            const windowKey = this.getWindowKey(run.model, run.cycleHour, run.runDate);

            // Skip if already active
            if (this.activeWindows.has(windowKey)) {
                continue;
            }

            // Check if window should start within the next minute OR is already active
            const timeToStart = run.detectionWindowStart.getTime() - now.getTime();
            const timeToEarlyTrigger = run.earlyTriggerStart.getTime() - now.getTime();
            const timeToStartSec = Math.round(timeToStart / 1000);
            const isAlreadyActive = now >= run.detectionWindowStart && now < run.detectionWindowEnd;
            const isEarlyTrigger = config.ENABLE_EARLY_TRIGGER && now >= run.earlyTriggerStart && now < run.detectionWindowStart;

            // Start if it's about to start (within 1 min), in early trigger mode, OR if it's already active and we missed the start
            // We use > -60000 (1 min late) previously, but now we allow any time as long as it's active
            if ((timeToStart <= 60000 && timeToStart > -60000) || isAlreadyActive || isEarlyTrigger) {
                // Log details only for runs that are about to start or already active
                if (run.model === 'RAP' || run.model === 'GFS' || run.model === 'ECMWF') {
                    const expectedFile = this.getExpectedFile(run.model, run.cycleHour, run.runDate);
                    logger.info(`[ScheduleManager] Checking ${run.model} ${String(run.cycleHour).padStart(2, '0')}Z: Path=${expectedFile.key}, Bucket=${expectedFile.bucket}`);
                }

                logger.info(`[ScheduleManager] ${run.model} ${String(run.cycleHour).padStart(2, '0')}Z: timeToStart=${timeToStartSec}s, active=${isAlreadyActive}, windowStart=${run.detectionWindowStart.toISOString()}`);
                // Create the detection window
                const expectedFile = this.getExpectedFile(run.model, run.cycleHour, run.runDate);

                const window: DetectionWindow = {
                    model: run.model,
                    cycleHour: run.cycleHour,
                    runDate: run.runDate,
                    windowStart: run.detectionWindowStart,
                    windowEnd: run.detectionWindowEnd,
                    expectedFile,
                    status: 'ACTIVE',
                    createdAt: now,
                };

                this.activeWindows.set(windowKey, window);

                logger.info(
                    `[ScheduleManager] Detection window started: ${run.model} ${String(run.cycleHour).padStart(2, '0')}Z`
                );

                // Emit event for S3FileDetector
                this.eventBus.emit({
                    type: 'DETECTION_WINDOW_START',
                    payload: {
                        model: run.model,
                        cycleHour: run.cycleHour,
                        runDate: run.runDate,
                        windowStart: run.detectionWindowStart,
                        isEarlyTrigger: isEarlyTrigger,
                        expectedFile: {
                            bucket: expectedFile.bucket,
                            key: expectedFile.key,
                            fullUrl: expectedFile.fullUrl,
                        },
                    },
                });

                this.emit('detectionWindowStart', window);

                // If in early trigger mode, emit special event for aggressive polling
                if (isEarlyTrigger) {
                    this.eventBus.emit({
                        type: 'EARLY_TRIGGER_MODE',
                        payload: {
                            model: run.model,
                            cycleHour: run.cycleHour,
                            minutesUntilExpected: Math.round(timeToEarlyTrigger / 60000),
                            aggressivePollIntervalMs: config.EARLY_TRIGGER_AGGRESSIVE_POLL_MS || 25,
                        },
                    });
                    logger.info(`[ScheduleManager] EARLY TRIGGER activated for ${run.model} ${String(run.cycleHour).padStart(2, '0')}Z - starting aggressive polling`);
                }
            }
        }

        // Clean up expired windows
        this.cleanupExpiredWindows();
    }

    /**
     * Clean up expired detection windows
     */
    private cleanupExpiredWindows(): void {
        const now = new Date();

        for (const [key, window] of this.activeWindows.entries()) {
            if (now > window.windowEnd) {
                logger.info(
                    `[ScheduleManager] Detection window expired: ${window.model} ${String(window.cycleHour).padStart(2, '0')}Z`
                );
                this.activeWindows.delete(key);
            }
        }
    }

    /**
     * Generate unique key for a window
     */
    private getWindowKey(model: ModelType, cycleHour: number, runDate: Date): string {
        const dateStr = runDate.toISOString().split('T')[0];
        return `${model}-${dateStr}-${String(cycleHour).padStart(2, '0')}Z`;
    }
}

export default ScheduleManager;