/**
 * Latency Tracker
 * Comprehensive end-to-end latency tracking from file detection to trade execution
 * 
 * Tracks a signal through the entire pipeline:
 * 1. File Detection (S3) -> 2. GRIB2 Parsing -> 3. Event Emission ->
 * 4. Forecast Processing -> 5. Strategy Analysis -> 6. Order Execution
 */

import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Latency measurement for a single trace
 */
export interface LatencyMeasurement {
    traceId: string;              // Unique ID for tracking a signal through the system
    
    // Timestamps (all in ms since epoch)
    modelPublishTime?: number;    // When model was officially published
    fileDetectedTime?: number;    // When S3 file was detected
    parseStartTime?: number;      // When GRIB2 parsing started
    parseEndTime?: number;        // When GRIB2 parsing completed
    eventEmitTime?: number;       // When event was emitted to EventBus
    forecastProcessedTime?: number; // When forecast change was processed
    strategyStartTime?: number;   // When strategy analysis started
    strategyEndTime?: number;     // When strategy analysis completed
    orderSubmitTime?: number;     // When order was submitted
    orderConfirmTime?: number;    // When order was confirmed
    
    // Calculated latencies
    detectionLatencyMs?: number;  // fileDetected - modelPublish
    parseLatencyMs?: number;      // parseEnd - parseStart
    eventLatencyMs?: number;      // eventEmit - parseEnd
    strategyLatencyMs?: number;   // strategyEnd - strategyStart
    executionLatencyMs?: number;  // orderConfirm - orderSubmit
    totalLatencyMs?: number;      // orderConfirm - fileDetected
    
    // Metadata
    model?: string;               // Weather model (HRRR, GFS, etc.)
    cycleHour?: number;           // Model cycle hour
    marketId?: string;            // Associated market ID
}

/**
 * Statistics for latency tracking
 */
export interface LatencyStats {
    avgTotalLatencyMs: number;
    p50TotalLatencyMs: number;
    p95TotalLatencyMs: number;
    p99TotalLatencyMs: number;
    sampleCount: number;
    avgDetectionLatencyMs: number;
    avgParseLatencyMs: number;
    avgEventLatencyMs: number;
    avgStrategyLatencyMs: number;
    avgExecutionLatencyMs: number;
}

/**
 * Time field keys for type-safe recording
 */
export type TimeField = 
    | 'modelPublishTime'
    | 'fileDetectedTime'
    | 'parseStartTime'
    | 'parseEndTime'
    | 'eventEmitTime'
    | 'forecastProcessedTime'
    | 'strategyStartTime'
    | 'strategyEndTime'
    | 'orderSubmitTime'
    | 'orderConfirmTime';

/**
 * Latency Tracker Singleton
 * Tracks end-to-end latency from file detection to trade execution
 */
export class LatencyTracker {
    private static instance: LatencyTracker | null = null;
    
    /** Active traces being tracked */
    private traces: Map<string, LatencyMeasurement> = new Map();
    
    /** Completed traces for statistics (circular buffer) */
    private completedTraces: LatencyMeasurement[] = [];
    
    /** Maximum number of completed traces to keep */
    private maxCompletedTraces: number;
    
    /** Whether tracking is enabled */
    private enabled: boolean;
    
    /** Whether to log all traces or just slow ones */
    private logAllTraces: boolean;
    
    /** Threshold for slow trace warning (ms) */
    private slowTraceThresholdMs: number;

    private constructor() {
        this.enabled = config.LATENCY_TRACKING_ENABLED ?? true;
        this.logAllTraces = config.LATENCY_LOG_ALL_TRACES ?? false;
        this.slowTraceThresholdMs = config.LATENCY_SLOW_TRACE_THRESHOLD_MS ?? 5000;
        this.maxCompletedTraces = config.LATENCY_STATS_WINDOW_SIZE ?? 100;
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): LatencyTracker {
        if (!LatencyTracker.instance) {
            LatencyTracker.instance = new LatencyTracker();
        }
        return LatencyTracker.instance;
    }

    /**
     * Reset singleton instance (useful for testing)
     */
    public static resetInstance(): void {
        LatencyTracker.instance = null;
    }

    /**
     * Start a new trace
     */
    public startTrace(traceId: string, metadata?: { model?: string; cycleHour?: number; marketId?: string }): void {
        if (!this.enabled) return;
        
        const measurement: LatencyMeasurement = {
            traceId,
            ...metadata,
        };
        
        this.traces.set(traceId, measurement);
        
        logger.debug(`[LatencyTracker] Started trace: ${traceId}`);
    }

    /**
     * Record a timestamp for a trace
     */
    public recordTime(traceId: string, field: TimeField, time?: number): void {
        if (!this.enabled) return;
        
        const trace = this.traces.get(traceId);
        if (!trace) {
            logger.warn(`[LatencyTracker] Trace not found: ${traceId}`);
            return;
        }
        
        const timestamp = time ?? Date.now();
        // Use type assertion with unknown intermediate for type safety
        (trace as unknown as Record<string, number | string | undefined>)[field] = timestamp;
    }

    /**
     * Complete a trace and calculate latencies
     */
    public completeTrace(traceId: string): LatencyMeasurement | null {
        if (!this.enabled) return null;
        
        const trace = this.traces.get(traceId);
        if (!trace) {
            logger.warn(`[LatencyTracker] Cannot complete trace - not found: ${traceId}`);
            return null;
        }
        
        // Calculate latencies
        this.calculateLatencies(trace);
        
        // Remove from active traces
        this.traces.delete(traceId);
        
        // Add to completed traces (circular buffer)
        this.completedTraces.push(trace);
        if (this.completedTraces.length > this.maxCompletedTraces) {
            this.completedTraces.shift();
        }
        
        // Log summary
        this.logTraceSummary(trace);
        
        return trace;
    }

    /**
     * Calculate all latency values for a trace
     */
    private calculateLatencies(trace: LatencyMeasurement): void {
        // Detection latency: fileDetected - modelPublish
        if (trace.fileDetectedTime && trace.modelPublishTime) {
            trace.detectionLatencyMs = trace.fileDetectedTime - trace.modelPublishTime;
        }
        
        // Parse latency: parseEnd - parseStart
        if (trace.parseEndTime && trace.parseStartTime) {
            trace.parseLatencyMs = trace.parseEndTime - trace.parseStartTime;
        }
        
        // Event latency: eventEmit - parseEnd
        if (trace.eventEmitTime && trace.parseEndTime) {
            trace.eventLatencyMs = trace.eventEmitTime - trace.parseEndTime;
        }
        
        // Strategy latency: strategyEnd - strategyStart
        if (trace.strategyEndTime && trace.strategyStartTime) {
            trace.strategyLatencyMs = trace.strategyEndTime - trace.strategyStartTime;
        }
        
        // Execution latency: orderConfirm - orderSubmit
        if (trace.orderConfirmTime && trace.orderSubmitTime) {
            trace.executionLatencyMs = trace.orderConfirmTime - trace.orderSubmitTime;
        }
        
        // Total latency: orderConfirm - fileDetected
        if (trace.orderConfirmTime && trace.fileDetectedTime) {
            trace.totalLatencyMs = trace.orderConfirmTime - trace.fileDetectedTime;
        }
    }

    /**
     * Log a summary of the trace
     */
    public logTraceSummary(trace: LatencyMeasurement): void {
        const totalMs = trace.totalLatencyMs;
        
        // Determine if this is a slow trace
        const isSlow = totalMs !== undefined && totalMs > this.slowTraceThresholdMs;
        
        // Only log if logAllTraces is true OR if it's a slow trace
        if (!this.logAllTraces && !isSlow) {
            return;
        }
        
        const parts: string[] = [];
        
        if (trace.detectionLatencyMs !== undefined) {
            parts.push(`Detection: ${trace.detectionLatencyMs}ms`);
        }
        if (trace.parseLatencyMs !== undefined) {
            parts.push(`Parse: ${trace.parseLatencyMs}ms`);
        }
        if (trace.eventLatencyMs !== undefined) {
            parts.push(`Event: ${trace.eventLatencyMs}ms`);
        }
        if (trace.strategyLatencyMs !== undefined) {
            parts.push(`Strategy: ${trace.strategyLatencyMs}ms`);
        }
        if (trace.executionLatencyMs !== undefined) {
            parts.push(`Execution: ${trace.executionLatencyMs}ms`);
        }
        
        if (isSlow) {
            logger.warn(
                `[LatencyTracker] Slow trace detected: ${totalMs}ms (threshold: ${this.slowTraceThresholdMs}ms)\n` +
                `  Trace ID: ${trace.traceId}\n` +
                `  Breakdown: ${parts.join(' | ')}`
            );
        } else {
            logger.info(
                `[LatencyTracker] Trace ${trace.traceId} completed in ${totalMs}ms:\n` +
                `  ${parts.join('\n  - ')}`
            );
        }
    }

    /**
     * Get statistics for completed traces
     */
    public getStats(): LatencyStats {
        const traces = this.completedTraces;
        const count = traces.length;
        
        if (count === 0) {
            return {
                avgTotalLatencyMs: 0,
                p50TotalLatencyMs: 0,
                p95TotalLatencyMs: 0,
                p99TotalLatencyMs: 0,
                sampleCount: 0,
                avgDetectionLatencyMs: 0,
                avgParseLatencyMs: 0,
                avgEventLatencyMs: 0,
                avgStrategyLatencyMs: 0,
                avgExecutionLatencyMs: 0,
            };
        }
        
        // Extract total latencies and sort for percentiles
        const totalLatencies = traces
            .map(t => t.totalLatencyMs)
            .filter((v): v is number => v !== undefined)
            .sort((a, b) => a - b);
        
        const detectionLatencies = traces
            .map(t => t.detectionLatencyMs)
            .filter((v): v is number => v !== undefined);
        
        const parseLatencies = traces
            .map(t => t.parseLatencyMs)
            .filter((v): v is number => v !== undefined);
        
        const eventLatencies = traces
            .map(t => t.eventLatencyMs)
            .filter((v): v is number => v !== undefined);
        
        const strategyLatencies = traces
            .map(t => t.strategyLatencyMs)
            .filter((v): v is number => v !== undefined);
        
        const executionLatencies = traces
            .map(t => t.executionLatencyMs)
            .filter((v): v is number => v !== undefined);
        
        return {
            avgTotalLatencyMs: this.average(totalLatencies),
            p50TotalLatencyMs: this.percentile(totalLatencies, 50),
            p95TotalLatencyMs: this.percentile(totalLatencies, 95),
            p99TotalLatencyMs: this.percentile(totalLatencies, 99),
            sampleCount: count,
            avgDetectionLatencyMs: this.average(detectionLatencies),
            avgParseLatencyMs: this.average(parseLatencies),
            avgEventLatencyMs: this.average(eventLatencies),
            avgStrategyLatencyMs: this.average(strategyLatencies),
            avgExecutionLatencyMs: this.average(executionLatencies),
        };
    }

    /**
     * Calculate average of an array
     */
    private average(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, v) => sum + v, 0) / values.length;
    }

    /**
     * Calculate percentile of a sorted array
     */
    private percentile(sortedValues: number[], p: number): number {
        if (sortedValues.length === 0) return 0;
        if (sortedValues.length === 1) return sortedValues[0];
        
        const index = Math.ceil((p / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
    }

    /**
     * Get a specific trace by ID (from active or completed)
     */
    public getTrace(traceId: string): LatencyMeasurement | undefined {
        return this.traces.get(traceId) ?? 
            this.completedTraces.find(t => t.traceId === traceId);
    }

    /**
     * Get number of active traces
     */
    public getActiveTraceCount(): number {
        return this.traces.size;
    }

    /**
     * Get number of completed traces
     */
    public getCompletedTraceCount(): number {
        return this.completedTraces.length;
    }

    /**
     * Clear all traces (useful for testing)
     */
    public clear(): void {
        this.traces.clear();
        this.completedTraces = [];
    }

    /**
     * Generate a unique trace ID
     */
    public static generateTraceId(model: string, cycleHour: number, forecastHour?: number): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 6);
        const parts = [model, cycleHour.toString().padStart(2, '0')];
        if (forecastHour !== undefined) {
            parts.push(forecastHour.toString().padStart(2, '0'));
        }
        parts.push(timestamp, random);
        return parts.join('-');
    }
}

// Export singleton instance getter
export const latencyTracker = LatencyTracker.getInstance();
export default LatencyTracker;
