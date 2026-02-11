/**
 * Drawdown Kill Switch - Critical Risk Control
 * 
 * Monitors trading performance and halts trading when losses exceed thresholds.
 * Implements multiple protection mechanisms:
 * - Daily loss limit
 * - Maximum drawdown from peak
 * - Consecutive loss counter
 * 
 * Singleton pattern ensures persistence across the application.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Current state of the kill switch
 */
export interface KillSwitchState {
    isTriggered: boolean;
    triggerReason: string | null;
    triggerTime: Date | null;
    dailyPnL: number;
    peakCapital: number;
    currentCapital: number;
    consecutiveLosses: number;
    totalTrades: number;
    dailyStartCapital: number;
    lastTradeTime: Date | null;
    cooldownExpiresAt: Date | null;
}

/**
 * Trade result for recording
 */
export interface TradeResult {
    pnl: number;
    timestamp: Date;
    capitalAfter: number;
}

/**
 * Kill switch trigger reasons
 */
enum TriggerReason {
    DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT',
    MAX_DRAWDOWN = 'MAX_DRAWDOWN',
    CONSECUTIVE_LOSSES = 'CONSECUTIVE_LOSSES',
    MANUAL = 'MANUAL'
}

/**
 * Warning thresholds (as percentage of limit)
 */
const WARNING_THRESHOLD = 0.80; // 80% of limit triggers warning

/**
 * DrawdownKillSwitch - Singleton class for risk control
 */
export class DrawdownKillSwitch {
    private static instance: DrawdownKillSwitch | null = null;
    
    // State
    private state: KillSwitchState;
    
    // Trade history for the current day
    private tradeHistory: TradeResult[] = [];
    
    // Lock for thread-safety (using a simple flag for single-threaded Node.js)
    private isProcessing: boolean = false;
    
    // Initial capital (set on first instantiation or reset)
    private initialCapital: number;
    
    private constructor(initialCapital: number = 1000) {
        this.initialCapital = initialCapital;
        this.state = {
            isTriggered: false,
            triggerReason: null,
            triggerTime: null,
            dailyPnL: 0,
            peakCapital: initialCapital,
            currentCapital: initialCapital,
            consecutiveLosses: 0,
            totalTrades: 0,
            dailyStartCapital: initialCapital,
            lastTradeTime: null,
            cooldownExpiresAt: null
        };
        
        logger.info('DrawdownKillSwitch initialized', {
            initialCapital,
            dailyLossLimit: `${(config.DRAWDOWN_DAILY_LOSS_LIMIT * 100).toFixed(1)}%`,
            maxDrawdownLimit: `${(config.DRAWDOWN_MAX_DRAWDOWN_LIMIT * 100).toFixed(1)}%`,
            consecutiveLossLimit: config.DRAWDOWN_CONSECUTIVE_LOSSES,
            cooldownHours: config.DRAWDOWN_COOLDOWN_HOURS,
            minTradesBeforeKill: config.DRAWDOWN_MIN_TRADES_BEFORE_KILL
        });
    }
    
    /**
     * Get the singleton instance
     */
    public static getInstance(initialCapital?: number): DrawdownKillSwitch {
        if (!DrawdownKillSwitch.instance) {
            DrawdownKillSwitch.instance = new DrawdownKillSwitch(initialCapital);
        }
        return DrawdownKillSwitch.instance;
    }
    
    /**
     * Reset the singleton instance (for testing)
     */
    public static resetInstance(): void {
        DrawdownKillSwitch.instance = null;
    }
    
    /**
     * Set the initial/current capital
     */
    public setCapital(capital: number): void {
        if (this.state.totalTrades > 0) {
            logger.warn('DrawdownKillSwitch: Setting capital after trades have been recorded', {
                oldCapital: this.state.currentCapital,
                newCapital: capital,
                totalTrades: this.state.totalTrades
            });
        }
        
        this.state.currentCapital = capital;
        this.state.peakCapital = Math.max(this.state.peakCapital, capital);
        
        // Reset daily start capital if no trades today
        if (this.tradeHistory.length === 0) {
            this.state.dailyStartCapital = capital;
        }
        
        this.initialCapital = capital;
    }
    
    /**
     * Check if trading should be halted
     */
    public shouldHaltTrading(): boolean {
        // Check if cooldown has passed
        this.resetIfCooldownPassed();
        
        if (this.state.isTriggered) {
            logger.warn('DrawdownKillSwitch: Trading is halted', {
                reason: this.state.triggerReason,
                triggerTime: this.state.triggerTime,
                cooldownExpires: this.state.cooldownExpiresAt
            });
            return true;
        }
        
        return false;
    }
    
    /**
     * Record a trade result (win/loss)
     */
    public recordTradeResult(pnl: number, capitalAfter?: number): void {
        // Prevent concurrent modifications
        if (this.isProcessing) {
            logger.warn('DrawdownKillSwitch: Concurrent trade recording detected, waiting...');
            return;
        }
        
        this.isProcessing = true;
        
        try {
            const now = new Date();
            const capital = capitalAfter ?? (this.state.currentCapital + pnl);
            
            // Record the trade
            const trade: TradeResult = {
                pnl,
                timestamp: now,
                capitalAfter: capital
            };
            this.tradeHistory.push(trade);
            
            // Update state
            this.state.currentCapital = capital;
            this.state.dailyPnL += pnl;
            this.state.totalTrades++;
            this.state.lastTradeTime = now;
            
            // Update peak capital
            if (capital > this.state.peakCapital) {
                this.state.peakCapital = capital;
            }
            
            // Update consecutive losses
            if (pnl < 0) {
                this.state.consecutiveLosses++;
            } else {
                this.state.consecutiveLosses = 0;
            }
            
            // Log the trade result
            this.logTradeResult(pnl);
            
            // Check thresholds and trigger if needed
            this.checkThresholds();
            
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Log trade result with threshold warnings
     */
    private logTradeResult(pnl: number): void {
        const pnlPercent = this.state.dailyStartCapital > 0 
            ? (this.state.dailyPnL / this.state.dailyStartCapital) 
            : 0;
        
        const dailyLimitPercent = Math.abs(pnlPercent / config.DRAWDOWN_DAILY_LOSS_LIMIT);
        const dailyLimitUsage = (dailyLimitPercent * 100).toFixed(0);
        
        const logLevel = pnl >= 0 ? 'info' : 'warn';
        const pnlSign = pnl >= 0 ? '+' : '';
        
        logger.log(logLevel, `Daily P&L: ${pnlSign}$${this.state.dailyPnL.toFixed(2)} (${(pnlPercent * 100).toFixed(1)}% loss, ${dailyLimitUsage}% of limit)`, {
            tradePnL: pnl,
            dailyPnL: this.state.dailyPnL,
            dailyPnLPercent: (pnlPercent * 100).toFixed(2),
            limitUsage: dailyLimitUsage,
            consecutiveLosses: this.state.consecutiveLosses,
            totalTrades: this.state.totalTrades
        });
        
        // Check for warning threshold (80% of limit)
        if (dailyLimitPercent >= WARNING_THRESHOLD && dailyLimitPercent < 1) {
            logger.warn(`Approaching daily loss limit: ${(dailyLimitPercent * 100).toFixed(1)}% of limit used`, {
                dailyPnL: this.state.dailyPnL,
                limit: config.DRAWDOWN_DAILY_LOSS_LIMIT,
                remaining: `${((1 - dailyLimitPercent) * 100).toFixed(1)}%`
            });
        }
    }
    
    /**
     * Check all thresholds and trigger kill switch if needed
     */
    private checkThresholds(): void {
        // Don't trigger if already triggered
        if (this.state.isTriggered) {
            return;
        }
        
        // Don't trigger if minimum trades not reached
        if (this.state.totalTrades < config.DRAWDOWN_MIN_TRADES_BEFORE_KILL) {
            logger.debug(`Kill switch: Not checking thresholds - only ${this.state.totalTrades} trades (min: ${config.DRAWDOWN_MIN_TRADES_BEFORE_KILL})`);
            return;
        }
        
        // Check daily loss limit
        const dailyLossPercent = this.state.dailyStartCapital > 0 
            ? Math.abs(this.state.dailyPnL / this.state.dailyStartCapital)
            : 0;
        
        if (this.state.dailyPnL < 0 && dailyLossPercent >= config.DRAWDOWN_DAILY_LOSS_LIMIT) {
            this.trigger(TriggerReason.DAILY_LOSS_LIMIT, 
                `Daily loss limit exceeded (${(dailyLossPercent * 100).toFixed(1)}% >= ${(config.DRAWDOWN_DAILY_LOSS_LIMIT * 100).toFixed(1)}%)`);
            return;
        }
        
        // Check max drawdown from peak
        const drawdownPercent = this.state.peakCapital > 0 
            ? (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital
            : 0;
        
        if (drawdownPercent >= config.DRAWDOWN_MAX_DRAWDOWN_LIMIT) {
            this.trigger(TriggerReason.MAX_DRAWDOWN,
                `Max drawdown exceeded (${(drawdownPercent * 100).toFixed(1)}% >= ${(config.DRAWDOWN_MAX_DRAWDOWN_LIMIT * 100).toFixed(1)}%)`);
            return;
        }
        
        // Check consecutive losses
        if (this.state.consecutiveLosses >= config.DRAWDOWN_CONSECUTIVE_LOSSES) {
            this.trigger(TriggerReason.CONSECUTIVE_LOSSES,
                `Consecutive loss limit reached (${this.state.consecutiveLosses} >= ${config.DRAWDOWN_CONSECUTIVE_LOSSES})`);
            return;
        }
    }
    
    /**
     * Trigger the kill switch
     */
    private trigger(reason: TriggerReason, message: string): void {
        const now = new Date();
        const cooldownMs = config.DRAWDOWN_COOLDOWN_HOURS * 60 * 60 * 1000;
        const cooldownExpires = new Date(now.getTime() + cooldownMs);
        
        this.state.isTriggered = true;
        this.state.triggerReason = reason;
        this.state.triggerTime = now;
        this.state.cooldownExpiresAt = cooldownExpires;
        
        logger.error(`KILL SWITCH TRIGGERED: ${message}`, {
            reason,
            triggerTime: now.toISOString(),
            cooldownExpires: cooldownExpires.toISOString(),
            cooldownHours: config.DRAWDOWN_COOLDOWN_HOURS,
            dailyPnL: this.state.dailyPnL,
            peakCapital: this.state.peakCapital,
            currentCapital: this.state.currentCapital,
            consecutiveLosses: this.state.consecutiveLosses,
            totalTrades: this.state.totalTrades
        });
        
        logger.info(`Trading halted for ${config.DRAWDOWN_COOLDOWN_HOURS} hours. Manual reset required to resume early.`);
    }
    
    /**
     * Reset after cooldown period has passed
     */
    public resetIfCooldownPassed(): boolean {
        if (!this.state.isTriggered || !this.state.cooldownExpiresAt) {
            return false;
        }
        
        const now = new Date();
        if (now >= this.state.cooldownExpiresAt) {
            this.performReset('Cooldown period expired');
            return true;
        }
        
        return false;
    }
    
    /**
     * Manual reset (requires authorization)
     * Returns true if reset was successful
     */
    public manualReset(authorizationCode?: string): { success: boolean; message: string } {
        if (!this.state.isTriggered) {
            return { success: false, message: 'Kill switch is not currently triggered' };
        }
        
        // In production, you would verify authorization here
        // For now, we just log the manual reset
        logger.warn('Manual kill switch reset requested', {
            triggerReason: this.state.triggerReason,
            triggerTime: this.state.triggerTime,
            timeSinceTrigger: this.state.triggerTime 
                ? `${((Date.now() - this.state.triggerTime.getTime()) / 1000 / 60).toFixed(1)} minutes`
                : 'unknown'
        });
        
        this.performReset('Manual reset');
        
        return { 
            success: true, 
            message: 'Kill switch has been manually reset. Trading may resume.' 
        };
    }
    
    /**
     * Perform the actual reset
     */
    private performReset(reason: string): void {
        const previousState = { ...this.state };
        
        // Reset state but preserve capital information
        this.state = {
            isTriggered: false,
            triggerReason: null,
            triggerTime: null,
            dailyPnL: 0,
            peakCapital: this.state.currentCapital, // Reset peak to current
            currentCapital: this.state.currentCapital,
            consecutiveLosses: 0,
            totalTrades: 0,
            dailyStartCapital: this.state.currentCapital,
            lastTradeTime: null,
            cooldownExpiresAt: null
        };
        
        // Clear trade history
        this.tradeHistory = [];
        
        logger.info(`Kill switch reset: ${reason}`, {
            previousTriggerReason: previousState.triggerReason,
            previousTriggerTime: previousState.triggerTime,
            currentCapital: this.state.currentCapital,
            dailyStartCapital: this.state.dailyStartCapital
        });
    }
    
    /**
     * Get current state (read-only copy)
     */
    public getState(): Readonly<KillSwitchState> {
        return { ...this.state };
    }
    
    /**
     * Get trade history for the current period
     */
    public getTradeHistory(): TradeResult[] {
        return [...this.tradeHistory];
    }
    
    /**
     * Get status summary for logging/display
     */
    public getStatusSummary(): string {
        const state = this.state;
        
        if (state.isTriggered) {
            const cooldownRemaining = state.cooldownExpiresAt 
                ? Math.max(0, state.cooldownExpiresAt.getTime() - Date.now())
                : 0;
            const hoursRemaining = (cooldownRemaining / 1000 / 60 / 60).toFixed(1);
            
            return `KILL SWITCH ACTIVE: ${state.triggerReason} | Cooldown: ${hoursRemaining}h remaining`;
        }
        
        const dailyPnLPercent = state.dailyStartCapital > 0 
            ? ((state.dailyPnL / state.dailyStartCapital) * 100).toFixed(2)
            : '0.00';
        const drawdownPercent = state.peakCapital > 0
            ? (((state.peakCapital - state.currentCapital) / state.peakCapital) * 100).toFixed(2)
            : '0.00';
        
        return `Trading Active | Daily P&L: ${state.dailyPnL >= 0 ? '+' : ''}$${state.dailyPnL.toFixed(2)} (${dailyPnLPercent}%) | Drawdown: ${drawdownPercent}% | Consecutive Losses: ${state.consecutiveLosses}/${config.DRAWDOWN_CONSECUTIVE_LOSSES}`;
    }
    
    /**
     * Check if approaching warning thresholds
     */
    public getWarningStatus(): { isWarning: boolean; warnings: string[] } {
        const warnings: string[] = [];
        
        if (this.state.isTriggered) {
            return { isWarning: false, warnings: [] };
        }
        
        // Check daily loss warning
        const dailyLossPercent = this.state.dailyStartCapital > 0 
            ? Math.abs(this.state.dailyPnL / this.state.dailyStartCapital)
            : 0;
        
        if (this.state.dailyPnL < 0 && dailyLossPercent >= config.DRAWDOWN_DAILY_LOSS_LIMIT * WARNING_THRESHOLD) {
            warnings.push(`Daily loss at ${(dailyLossPercent * 100).toFixed(1)}% (${(dailyLossPercent / config.DRAWDOWN_DAILY_LOSS_LIMIT * 100).toFixed(0)}% of limit)`);
        }
        
        // Check drawdown warning
        const drawdownPercent = this.state.peakCapital > 0 
            ? (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital
            : 0;
        
        if (drawdownPercent >= config.DRAWDOWN_MAX_DRAWDOWN_LIMIT * WARNING_THRESHOLD) {
            warnings.push(`Drawdown at ${(drawdownPercent * 100).toFixed(1)}% (${(drawdownPercent / config.DRAWDOWN_MAX_DRAWDOWN_LIMIT * 100).toFixed(0)}% of limit)`);
        }
        
        // Check consecutive losses warning
        if (this.state.consecutiveLosses >= Math.floor(config.DRAWDOWN_CONSECUTIVE_LOSSES * WARNING_THRESHOLD)) {
            warnings.push(`Consecutive losses at ${this.state.consecutiveLosses}/${config.DRAWDOWN_CONSECUTIVE_LOSSES}`);
        }
        
        return {
            isWarning: warnings.length > 0,
            warnings
        };
    }
    
    /**
     * Start a new trading day (reset daily counters)
     */
    public startNewDay(): void {
        logger.info('Starting new trading day', {
            previousDailyPnL: this.state.dailyPnL,
            currentCapital: this.state.currentCapital
        });
        
        // Reset daily-specific counters
        this.state.dailyPnL = 0;
        this.state.dailyStartCapital = this.state.currentCapital;
        this.state.consecutiveLosses = 0;
        this.tradeHistory = [];
        
        // Note: We don't reset totalTrades or isTriggered here
        // isTriggered can only be reset by cooldown or manual reset
    }
}

// Export singleton getter as default
export default DrawdownKillSwitch.getInstance;
