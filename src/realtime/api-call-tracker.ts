/**
 * API Call Tracker
 * Tracks API calls across all weather providers with daily counters
 * Supports rate limit monitoring, budget management, and hard quota enforcement
 * 
 * HARD QUOTA: Open-Meteo has a hard limit of 9,500 calls per day
 * When exceeded, Open-Meteo is immediately disabled and skipped in burst rotation
 */

import { logger } from '../logger.js';
import { EventEmitter } from 'events';

/**
 * Provider API call record
 */
export interface ProviderCallRecord {
    provider: string;
    callCount: number;
    lastCallTime: Date | null;
    dailyLimit: number | null; // null means unlimited (e.g., Open-Meteo)
    hardQuotaLimit: number | null; // Hard limit at which provider is disabled
    isRateLimited: boolean;
    isQuotaExceeded: boolean; // Hard quota exceeded - provider disabled
    rateLimitResetTime: Date | null;
}

/**
 * Daily API usage statistics
 */
export interface DailyApiStats {
    date: string; // YYYY-MM-DD format
    totalCalls: number;
    providerBreakdown: Map<string, number>;
    costEstimate: number; // Estimated cost in USD
}

/**
 * API budget configuration per provider
 */
export interface ApiBudgetConfig {
    dailyLimit: number | null;
    hardQuotaLimit: number | null; // Hard limit for quota enforcement
    costPerCall: number; // in USD
    warningThreshold: number; // percentage (0-1) of limit to warn at
}

// Default budget configurations
// Open-Meteo: Hard quota at 9,500 calls
const DEFAULT_BUDGETS: Map<string, ApiBudgetConfig> = new Map([
    ['openmeteo', { dailyLimit: null, hardQuotaLimit: 9500, costPerCall: 0, warningThreshold: 0.9 }], // Free, hard limit 9500
    ['tomorrow', { dailyLimit: 1000, hardQuotaLimit: null, costPerCall: 0, warningThreshold: 0.8 }], // Free tier
    ['openweather', { dailyLimit: 1000, hardQuotaLimit: null, costPerCall: 0.001, warningThreshold: 0.8 }],
    ['weatherapi', { dailyLimit: 1000000, hardQuotaLimit: null, costPerCall: 0.0001, warningThreshold: 0.9 }],
    ['weatherbit', { dailyLimit: 500, hardQuotaLimit: null, costPerCall: 0, warningThreshold: 0.8 }], // Free tier
    ['visualcrossing', { dailyLimit: 1000, hardQuotaLimit: null, costPerCall: 0, warningThreshold: 0.8 }], // Free tier
    ['meteosource', { dailyLimit: 10000, hardQuotaLimit: null, costPerCall: 0, warningThreshold: 0.9 }],
]);

/**
 * API Call Tracker
 * Singleton class for tracking API calls across all providers
 */
export class ApiCallTracker extends EventEmitter {
    private static instance: ApiCallTracker | null = null;
    private providerRecords: Map<string, ProviderCallRecord> = new Map();
    private dailyStats: Map<string, DailyApiStats> = new Map();
    private budgetConfigs: Map<string, ApiBudgetConfig> = new Map();
    private currentDate: string;

    // Track burst mode state
    private isInBurstMode: boolean = false;
    private burstModeStartTime: Date | null = null;
    private burstModeCalls: number = 0;

    private constructor() {
        super();
        this.currentDate = this.getDateString(new Date());
        this.initializeBudgets();
        this.initializeProviders();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ApiCallTracker {
        if (!ApiCallTracker.instance) {
            ApiCallTracker.instance = new ApiCallTracker();
        }
        return ApiCallTracker.instance;
    }

    /**
     * Initialize default budget configurations
     */
    private initializeBudgets(): void {
        for (const [provider, config] of DEFAULT_BUDGETS) {
            this.budgetConfigs.set(provider, config);
        }
    }

    /**
     * Initialize provider records
     */
    private initializeProviders(): void {
        const providers = ['openmeteo', 'tomorrow', 'openweather', 'weatherapi', 'weatherbit', 'visualcrossing', 'meteosource'];
        for (const provider of providers) {
            const config = this.budgetConfigs.get(provider);
            this.providerRecords.set(provider, {
                provider,
                callCount: 0,
                lastCallTime: null,
                dailyLimit: config?.dailyLimit ?? null,
                hardQuotaLimit: config?.hardQuotaLimit ?? null,
                isRateLimited: false,
                isQuotaExceeded: false,
                rateLimitResetTime: null,
            });
        }
    }

    /**
     * Get date string in YYYY-MM-DD format
     */
    private getDateString(date: Date): string {
        return date.toISOString().split('T')[0];
    }

    /**
     * Check if we need to roll over to a new day
     */
    private checkDayRollover(): void {
        const now = new Date();
        const today = this.getDateString(now);

        if (today !== this.currentDate) {
            // Archive current day's stats
            const currentStats = this.getDailyStats(this.currentDate);
            if (currentStats) {
                this.emit('dayRollover', { date: this.currentDate, stats: currentStats });
            }

            // Reset counters for new day
            this.currentDate = today;
            this.resetDailyCounters();
            logger.info('API Call Tracker: Day rollover, counters reset', { newDate: today });
        }
    }

    /**
     * Reset daily counters for all providers
     */
    private resetDailyCounters(): void {
        for (const record of this.providerRecords.values()) {
            record.callCount = 0;
            record.isRateLimited = false;
            record.isQuotaExceeded = false;
            record.rateLimitResetTime = null;
        }
        this.burstModeCalls = 0;
    }

    /**
     * Record an API call
     */
    public recordCall(provider: string, success: boolean = true): void {
        this.checkDayRollover();

        const record = this.providerRecords.get(provider);
        if (!record) {
            logger.warn(`Unknown provider: ${provider}`);
            return;
        }

        record.callCount++;
        record.lastCallTime = new Date();

        if (this.isInBurstMode) {
            this.burstModeCalls++;
        }

        // Update daily stats
        const stats = this.getOrCreateDailyStats(this.currentDate);
        stats.totalCalls++;
        const currentCount = stats.providerBreakdown.get(provider) || 0;
        stats.providerBreakdown.set(provider, currentCount + 1);

        // Calculate cost
        const config = this.budgetConfigs.get(provider);
        if (config) {
            stats.costEstimate += config.costPerCall;
        }

        // Check for hard quota exceeded (immediate disable)
        if (record.hardQuotaLimit && record.callCount >= record.hardQuotaLimit) {
            if (!record.isQuotaExceeded) {
                record.isQuotaExceeded = true;
                this.emit('quotaExceeded', {
                    provider,
                    callCount: record.callCount,
                    hardQuotaLimit: record.hardQuotaLimit,
                });
                logger.error(`🚫 HARD QUOTA EXCEEDED: ${provider} at ${record.callCount} calls (limit: ${record.hardQuotaLimit}). Provider DISABLED.`);
            }
        }

        // Check for warning threshold
        if (record.dailyLimit && record.callCount >= record.dailyLimit * (config?.warningThreshold || 0.8)) {
            if (record.callCount === Math.ceil(record.dailyLimit * (config?.warningThreshold || 0.8))) {
                this.emit('budgetWarning', {
                    provider,
                    callCount: record.callCount,
                    dailyLimit: record.dailyLimit,
                    percentage: (record.callCount / record.dailyLimit) * 100,
                });
                logger.warn(`API budget warning: ${provider} at ${(record.callCount / record.dailyLimit * 100).toFixed(1)}% of daily limit`);
            }
        }

        // Emit call recorded event
        this.emit('callRecorded', {
            provider,
            callCount: record.callCount,
            success,
            timestamp: record.lastCallTime,
        });
    }

    /**
     * Check if a provider's hard quota is exceeded
     * When exceeded, the provider should be skipped in burst rotation
     */
    public isQuotaExceeded(provider: string): boolean {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record) return false;
        return record.isQuotaExceeded;
    }

    /**
     * Get remaining calls before hard quota is reached
     */
    public getRemainingQuota(provider: string): number | null {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record || record.hardQuotaLimit === null) return null;
        return Math.max(0, record.hardQuotaLimit - record.callCount);
    }

    /**
     * Get quota usage percentage
     */
    public getQuotaUsagePercentage(provider: string): number {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record || record.hardQuotaLimit === null) return 0;
        return (record.callCount / record.hardQuotaLimit) * 100;
    }

    /**
     * Mark a provider as rate limited
     */
    public setRateLimited(provider: string, resetTime?: Date): void {
        const record = this.providerRecords.get(provider);
        if (record) {
            record.isRateLimited = true;
            record.rateLimitResetTime = resetTime || new Date(Date.now() + 3600000); // Default 1 hour
            this.emit('rateLimited', { provider, resetTime: record.rateLimitResetTime });
            logger.warn(`Provider ${provider} marked as rate limited until ${record.rateLimitResetTime}`);
        }
    }

    /**
     * Clear rate limit status for a provider
     */
    public clearRateLimit(provider: string): void {
        const record = this.providerRecords.get(provider);
        if (record) {
            record.isRateLimited = false;
            record.rateLimitResetTime = null;
            this.emit('rateLimitCleared', { provider });
        }
    }

    /**
     * Check if a provider is currently rate limited
     */
    public isRateLimited(provider: string): boolean {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record) return false;

        if (record.isRateLimited && record.rateLimitResetTime) {
            if (new Date() >= record.rateLimitResetTime) {
                this.clearRateLimit(provider);
                return false;
            }
            return true;
        }
        return false;
    }

    /**
     * Get remaining calls for a provider today
     */
    public getRemainingCalls(provider: string): number | null {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record || record.dailyLimit === null) return null;
        return Math.max(0, record.dailyLimit - record.callCount);
    }

    /**
     * Get usage percentage for a provider
     */
    public getUsagePercentage(provider: string): number {
        this.checkDayRollover();
        const record = this.providerRecords.get(provider);
        if (!record || record.dailyLimit === null) return 0;
        return (record.callCount / record.dailyLimit) * 100;
    }

    /**
     * Get provider call record
     */
    public getProviderRecord(provider: string): ProviderCallRecord | undefined {
        this.checkDayRollover();
        return this.providerRecords.get(provider);
    }

    /**
     * Get all provider records
     */
    public getAllProviderRecords(): ProviderCallRecord[] {
        this.checkDayRollover();
        return Array.from(this.providerRecords.values());
    }

    /**
     * Get or create daily stats
     */
    private getOrCreateDailyStats(date: string): DailyApiStats {
        let stats = this.dailyStats.get(date);
        if (!stats) {
            stats = {
                date,
                totalCalls: 0,
                providerBreakdown: new Map(),
                costEstimate: 0,
            };
            this.dailyStats.set(date, stats);
        }
        return stats;
    }

    /**
     * Get daily stats for a specific date
     */
    public getDailyStats(date: string): DailyApiStats | undefined {
        return this.dailyStats.get(date);
    }

    /**
     * Get today's stats
     */
    public getTodayStats(): DailyApiStats {
        this.checkDayRollover();
        return this.getOrCreateDailyStats(this.currentDate);
    }

    /**
     * Enter burst mode (60-second intensive polling)
     */
    public enterBurstMode(): void {
        if (!this.isInBurstMode) {
            this.isInBurstMode = true;
            this.burstModeStartTime = new Date();
            this.burstModeCalls = 0;
            this.emit('burstModeEnter', { startTime: this.burstModeStartTime });
            logger.info('API Call Tracker: Entered burst mode');
        }
    }

    /**
     * Exit burst mode
     */
    public exitBurstMode(): void {
        if (this.isInBurstMode) {
            const duration = this.burstModeStartTime 
                ? Date.now() - this.burstModeStartTime.getTime() 
                : 0;
            this.isInBurstMode = false;
            this.emit('burstModeExit', { 
                durationMs: duration, 
                totalCalls: this.burstModeCalls 
            });
            logger.info('API Call Tracker: Exited burst mode', {
                durationMs: duration,
                totalCalls: this.burstModeCalls
            });
            this.burstModeStartTime = null;
            this.burstModeCalls = 0;
        }
    }

    /**
     * Check if currently in burst mode
     */
    public getBurstModeStatus(): { isActive: boolean; durationMs: number; calls: number } {
        return {
            isActive: this.isInBurstMode,
            durationMs: this.burstModeStartTime ? Date.now() - this.burstModeStartTime.getTime() : 0,
            calls: this.burstModeCalls,
        };
    }

    /**
     * Get total API calls across all providers today
     */
    public getTotalCallsToday(): number {
        this.checkDayRollover();
        let total = 0;
        for (const record of this.providerRecords.values()) {
            total += record.callCount;
        }
        return total;
    }

    /**
     * Get estimated daily cost
     */
    public getEstimatedDailyCost(): number {
        const stats = this.getTodayStats();
        return stats.costEstimate;
    }

    /**
     * Set custom budget configuration for a provider
     */
    public setBudgetConfig(provider: string, config: Partial<ApiBudgetConfig>): void {
        const existing = this.budgetConfigs.get(provider) || {
            dailyLimit: null,
            hardQuotaLimit: null,
            costPerCall: 0,
            warningThreshold: 0.8,
        };
        this.budgetConfigs.set(provider, { ...existing, ...config });
        
        // Update record's daily limit
        const record = this.providerRecords.get(provider);
        if (record) {
            if (config.dailyLimit !== undefined) {
                record.dailyLimit = config.dailyLimit;
            }
            if (config.hardQuotaLimit !== undefined) {
                record.hardQuotaLimit = config.hardQuotaLimit;
            }
        }
    }

    /**
     * Get budget configuration for a provider
     */
    public getBudgetConfig(provider: string): ApiBudgetConfig | undefined {
        return this.budgetConfigs.get(provider);
    }

    /**
     * Get comprehensive status report
     */
    public getStatusReport(): {
        date: string;
        totalCalls: number;
        estimatedCost: number;
        burstMode: { isActive: boolean; durationMs: number; calls: number };
        providers: ProviderCallRecord[];
    } {
        return {
            date: this.currentDate,
            totalCalls: this.getTotalCallsToday(),
            estimatedCost: this.getEstimatedDailyCost(),
            burstMode: this.getBurstModeStatus(),
            providers: this.getAllProviderRecords(),
        };
    }

    /**
     * Reset all counters (useful for testing)
     */
    public reset(): void {
        this.resetDailyCounters();
        this.dailyStats.clear();
        this.currentDate = this.getDateString(new Date());
        this.isInBurstMode = false;
        this.burstModeStartTime = null;
        this.burstModeCalls = 0;
        logger.info('API Call Tracker: All counters reset');
    }
}

// Export singleton instance
export const apiCallTracker = ApiCallTracker.getInstance();
