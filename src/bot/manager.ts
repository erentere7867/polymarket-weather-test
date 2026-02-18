/**
 * Bot Manager - Production Ready Weather Trading Bot
 * Hybrid trading strategy implementation
 *
 * Integrates DrawdownKillSwitch for risk control
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OrderExecutor } from './order-executor.js';
import { HybridTradingStrategy, HybridSignal } from '../strategy/hybrid-trading-strategy.js';
import { DataStore } from '../realtime/data-store.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { config, validateConfig } from '../config.js';
import { logger, rateLimitedLogger } from '../logger.js';
import { TradingOpportunity } from '../polymarket/types.js';
import { eventBus } from '../realtime/event-bus.js';
import { EntrySignal } from '../strategy/entry-optimizer.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { MarketModel } from '../probability/market-model.js';
import { DrawdownKillSwitch } from '../strategy/drawdown-kill-switch.js';
import { ExitOptimizer } from '../strategy/exit-optimizer.js';

interface BotStats {
    startTime: Date;
    cyclesCompleted: number;
    marketsScanned: number;
    opportunitiesFound: number;
    opportunitiesExecuted: number;
    tradesExecuted: number;
    errors: number;
    rejectedTrades: number;
}

export class BotManager {
    private weatherScanner: WeatherScanner;
    private tradingClient: TradingClient;
    private hybridStrategy: HybridTradingStrategy;
    private opportunityDetector!: OpportunityDetector;
    private orderExecutor: OrderExecutor;
    private dataStore: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    
    // Kill switch for risk control
    private killSwitch: DrawdownKillSwitch;
    
    // Exit management
    private exitOptimizer: ExitOptimizer | null = null;
    private openPositions: Map<string, {
        marketId: string;
        side: 'yes' | 'no';
        entryPrice: number;
        size: number;
        entryTime: Date;
        forecastProbAtEntry: number;
    }> = new Map();
    
    // Daily reset timer
    private dailyResetTimer: NodeJS.Timeout | null = null;

    private isRunning: boolean = false;
    private stats: BotStats;
    private currentDelayTimeout: NodeJS.Timeout | null = null;
    private delayResolve: (() => void) | null = null;
    private cycleLock: Promise<void> | null = null;
    private eventUnsubscribers: (() => void)[] = [];
    
    // Forecast-triggered cycle guards
    private dirtyMarkets: Set<string> = new Set();

    private initialCapital: number;

    constructor(initialCapital: number = 1000) {
        this.initialCapital = initialCapital;
        
        // Initialize kill switch singleton
        this.killSwitch = DrawdownKillSwitch.getInstance(initialCapital);
        
        this.weatherScanner = new WeatherScanner();
        this.tradingClient = new TradingClient();
        this.dataStore = new DataStore();
        this.opportunityDetector = new OpportunityDetector(this.dataStore);
        this.hybridStrategy = new HybridTradingStrategy(this.dataStore);
        
        this.orderExecutor = new OrderExecutor(this.tradingClient, this.dataStore);
        this.priceTracker = new PriceTracker(this.dataStore);
        this.forecastMonitor = new ForecastMonitor(this.dataStore);

        this.stats = {
            startTime: new Date(),
            cyclesCompleted: 0,
            marketsScanned: 0,
            opportunitiesFound: 0,
            opportunitiesExecuted: 0,
            tradesExecuted: 0,
            errors: 0,
            rejectedTrades: 0,
        };
    }

    /**
     * Initialize the bot
     */
    async initialize(): Promise<void> {
        logger.info('='.repeat(60));
        logger.info('Weather Trading Bot - Starting');
        logger.info('='.repeat(60));

        validateConfig();

        await this.tradingClient.initialize();

        // Initialize ExitOptimizer
        const marketModel = new MarketModel(this.dataStore);
        this.exitOptimizer = new ExitOptimizer(marketModel);
        logger.info('[BotManager] ExitOptimizer initialized');

        // Start PriceTracker
        await this.priceTracker.start(this.weatherScanner, 60000);

        // Setup forecast monitor
        this.forecastMonitor.onForecastChanged = async (marketId, change) => {
            this.dirtyMarkets.add(marketId);
        };
    }

    /**
     * Main scan cycle - uses proper mutex lock to prevent overlapping runs
     */
    async runCycle(): Promise<void> {
        // Wait for any existing cycle to complete
        if (this.cycleLock) {
            await this.cycleLock;
            return; // Skip this cycle since another just completed
        }
        
        this.cycleLock = this.executeCycleInternal();
        try {
            await this.cycleLock;
        } finally {
            this.cycleLock = null;
        }
    }

    /**
     * Internal cycle execution - renamed from runCycle body
     */
    private async executeCycleInternal(): Promise<void> {
        const cycleStart = Date.now();

        try {
            // CRITICAL: Check kill switch before any trading
            if (this.killSwitch.shouldHaltTrading()) {
                logger.warn('[BotManager] Trading halted by kill switch', {
                    killSwitchState: this.killSwitch.getState()
                });
                return;
            }
            
            // Log warning if approaching thresholds
            const warningStatus = this.killSwitch.getWarningStatus();
            if (warningStatus.isWarning) {
                logger.warn('[BotManager] Approaching kill switch thresholds', {
                    warnings: warningStatus.warnings
                });
            }

            const allMarkets = this.dataStore.getAllMarkets();
            this.stats.marketsScanned += allMarkets.length;

            if (allMarkets.length === 0) {
                return;
            }

            const actionableMarkets = this.weatherScanner.filterActionableMarkets(allMarkets);
            
            if (actionableMarkets.length === 0) {
                return;
            }

            // Always use hybrid strategy
            const hybridSignals = this.hybridStrategy.detectOpportunities();
            const signals: EntrySignal[] = hybridSignals;
            
            if (signals.length === 0) {
                return;
            }

            // Convert signals to opportunities
            const opportunities = signals
                .map(s => this.convertSignalToOpportunity(s))
                .filter((o): o is TradingOpportunity => o !== null);

            this.stats.opportunitiesFound += opportunities.length;

            // Execute trades
            if (opportunities.length > 0) {
                const results = await this.orderExecutor.executeOpportunities(opportunities);
                const executed = results.filter(r => r.executed);
                this.stats.tradesExecuted += executed.length;
                this.stats.opportunitiesExecuted += executed.length;

                // Track positions and record trade for kill switch
                for (const result of executed) {
                    const opp = result.opportunity;
                    
                    // Track open position for exit management
                    this.openPositions.set(opp.market.market.id, {
                        marketId: opp.market.market.id,
                        side: opp.action === 'buy_yes' ? 'yes' : 'no',
                        entryPrice: opp.action === 'buy_yes' ? opp.snapshotYesPrice : opp.snapshotNoPrice,
                        size: opp.suggestedSize || config.maxPositionSize,
                        entryTime: new Date(),
                        forecastProbAtEntry: opp.forecastProbability,
                    });
                    
                    // Mark captured for strategy
                    if (opp.forecastValue !== undefined) {
                        const hybridSignal = signals.find(s => s.marketId === opp.market.market.id) as HybridSignal | undefined;
                        this.hybridStrategy.markOpportunityCaptured(
                            opp.market.market.id, 
                            opp.forecastValue,
                            hybridSignal?.signalType || 'high_confidence'
                        );
                    }
                }

                rateLimitedLogger.info('trade-execution',
                    `Executed ${executed.length}/${opportunities.length} trades`);
            }

        } catch (error) {
            this.stats.errors++;
            logger.error('Cycle error', { error: (error as Error).message });
        } finally {
            this.stats.cyclesCompleted++;
            
            const duration = Date.now() - cycleStart;
            if (duration > 1000) {
                logger.debug(`Cycle completed in ${(duration / 1000).toFixed(1)}s`);
            }
        }
    }

    /**
     * Convert EntrySignal to TradingOpportunity
     */
    private convertSignalToOpportunity(signal: EntrySignal): TradingOpportunity | null {
        const state = this.dataStore.getMarketState(signal.marketId);
        if (!state) return null;

        const market = state.market;
        const forecast = state.lastForecast;

        // Calculate forecast probability
        let forecastProbability = forecast?.probability;
        if (forecastProbability === undefined) {
            forecastProbability = signal.side === 'yes'
                ? market.yesPrice + Math.abs(signal.estimatedEdge)
                : market.yesPrice - Math.abs(signal.estimatedEdge);
        }
        forecastProbability = Math.max(0.01, Math.min(0.99, forecastProbability));

        return {
            market,
            forecastProbability,
            marketProbability: market.yesPrice,
            edge: forecastProbability - market.yesPrice,
            action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
            confidence: signal.confidence,
            reason: signal.reason,
            weatherDataSource: 'noaa',
            forecastValue: forecast?.forecastValue,
            forecastValueUnit: market.thresholdUnit || '°F',
            isGuaranteed: signal.isGuaranteed,
            snapshotYesPrice: market.yesPrice,
            snapshotNoPrice: market.noPrice,
            snapshotTimestamp: new Date(),
        };
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        this.isRunning = true;
        this.forecastMonitor.start();

        logger.info('Bot running');

        while (this.isRunning) {
            await this.runCycle();
            
            if (this.isRunning) {
                await this.delay(config.pollIntervalMs);
            }
        }

        logger.info('Bot stopped');
    }

    /**
     * Stop the bot
     */
    stop(): void {
        logger.info('Stopping bot...');
        this.isRunning = false;
        this.priceTracker.stop();
        this.forecastMonitor.stop();

        // Clean up event bus listeners
        for (const unsub of this.eventUnsubscribers) {
            unsub();
        }
        this.eventUnsubscribers = [];

        if (this.currentDelayTimeout) {
            clearTimeout(this.currentDelayTimeout);
            this.currentDelayTimeout = null;
        }
        if (this.delayResolve) {
            this.delayResolve();
            this.delayResolve = null;
        }
    }

    /**
     * Get current stats
     */
    getStats(): BotStats {
        return { ...this.stats };
    }
    
    /**
     * Get the kill switch instance
     */
    getKillSwitch(): DrawdownKillSwitch {
        return this.killSwitch;
    }
    
    /**
     * Record a trade result for kill switch monitoring
     * Call this after each trade completes with its P&L
     */
    recordTradeResult(pnl: number, capitalAfter?: number): void {
        this.killSwitch.recordTradeResult(pnl, capitalAfter);
    }
    
    /**
     * Get kill switch status summary for logging
     */
    getKillSwitchStatus(): string {
        return this.killSwitch.getStatusSummary();
    }
    
    /**
     * Manually reset the kill switch (use with caution)
     */
    resetKillSwitch(): { success: boolean; message: string } {
        return this.killSwitch.manualReset();
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.delayResolve = resolve;
            this.currentDelayTimeout = setTimeout(() => {
                this.currentDelayTimeout = null;
                this.delayResolve = null;
                resolve();
            }, ms);
        });
    }
}

export default BotManager;
