/**
 * Bot Manager - Production Ready Weather Trading Bot
 * Clean dual-mode implementation:
 * - SPEED MODE: Fast execution on forecast changes (speed arbitrage)
 * - SAFE MODE: Conservative execution with high confidence requirements
 *
 * Integrates DrawdownKillSwitch for risk control
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OrderExecutor } from './order-executor.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';
import { ConfidenceCompressionStrategy } from '../strategy/confidence-compression-strategy.js';
import { StrategyOrchestrator, StrategySignal } from '../strategy/strategy-orchestrator.js';
import { DataStore } from '../realtime/data-store.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { config, validateConfig } from '../config.js';
import { logger, rateLimitedLogger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';
import { eventBus } from '../realtime/event-bus.js';
import { forecastStateMachine } from '../realtime/forecast-state-machine.js';
import { EntrySignal } from '../strategy/entry-optimizer.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { MarketModel } from '../probability/market-model.js';
import { DrawdownKillSwitch } from '../strategy/drawdown-kill-switch.js';

export type TradingMode = 'speed' | 'safe' | 'orchestrated';

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
    private speedStrategy: SpeedArbitrageStrategy;
    private confidenceStrategy: ConfidenceCompressionStrategy;
    private strategyOrchestrator: StrategyOrchestrator | null = null;
    private opportunityDetector!: OpportunityDetector;
    private orderExecutor: OrderExecutor;
    private dataStore: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    
    // Kill switch for risk control
    private killSwitch: DrawdownKillSwitch;

    private isRunning: boolean = false;
    private stats: BotStats;
    private currentDelayTimeout: NodeJS.Timeout | null = null;
    private delayResolve: (() => void) | null = null;
    private cycleLock: Promise<void> | null = null;
    private eventUnsubscribers: (() => void)[] = [];
    
    // Trading mode
    private tradingMode: TradingMode;
    
    // Forecast-triggered cycle guards
    private lastForecastTriggeredCycle: Date | null = null;
    private readonly FORECAST_CYCLE_DEBOUNCE_MS = 3000;
    private dirtyMarkets: Set<string> = new Set();

    private initialCapital: number;

    constructor(mode?: TradingMode, initialCapital: number = 1000) {
        this.tradingMode = mode || (config.ENABLE_STRATEGY_ORCHESTRATOR ? 'orchestrated' : (config.SPEED_ARBITRAGE_MODE ? 'speed' : 'safe'));
        this.initialCapital = initialCapital;
        
        // Initialize kill switch singleton
        this.killSwitch = DrawdownKillSwitch.getInstance(initialCapital);
        
        this.weatherScanner = new WeatherScanner();
        this.tradingClient = new TradingClient();
        this.dataStore = new DataStore();
        this.opportunityDetector = new OpportunityDetector(this.dataStore);
        this.speedStrategy = new SpeedArbitrageStrategy(this.dataStore);
        this.confidenceStrategy = new ConfidenceCompressionStrategy(this.dataStore);
        
        // Orchestrator will be initialized in initialize() method
        this.strategyOrchestrator = null;
        
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
        logger.info(`Mode: ${this.tradingMode.toUpperCase()}`);
        logger.info('='.repeat(60));

        validateConfig();

        await this.tradingClient.initialize();

        // Initialize orchestrator if enabled
        if (config.ENABLE_STRATEGY_ORCHESTRATOR && !this.strategyOrchestrator) {
            const marketModel = new MarketModel(this.dataStore);
            this.strategyOrchestrator = new StrategyOrchestrator(
                this.dataStore,
                this.opportunityDetector,
                marketModel,
                this.initialCapital
            );
            logger.info('[BotManager] Strategy Orchestrator initialized');
        }

        // Start PriceTracker
        await this.priceTracker.start(this.weatherScanner, 60000);

        // Wire forecast events to strategies
        const forecastUnsub = eventBus.on('FORECAST_CHANGE', (event) => {
            if (event.type === 'FORECAST_CHANGE') {
                this.handleForecastEvent(event.payload);
            }
        });
        this.eventUnsubscribers.push(forecastUnsub);

        // Setup forecast monitor
        this.forecastMonitor.onForecastChanged = async (marketId, change) => {
            this.dirtyMarkets.add(marketId);
            await this.handleForecastChange(marketId, change);
        };
    }

    /**
     * Handle forecast event - feed to appropriate strategy
     */
    private handleForecastEvent(payload: {
        cityId: string;
        cityName: string;
        variable: 'TEMPERATURE' | 'WIND_SPEED' | 'PRECIPITATION';
        oldValue: number;
        newValue: number;
        changeAmount: number;
        changePercent: number;
        model: string;
        cycleHour: number;
        forecastHour: number;
        timestamp: Date;
        source: 'FILE' | 'API';
        confidence: 'HIGH' | 'LOW';
        threshold: number;
        thresholdExceeded: boolean;
    }): void {
        const runDate = payload.timestamp;
        
        if (payload.variable === 'TEMPERATURE') {
            this.confidenceStrategy.processModelRun(
                payload.cityId,
                payload.model as any,
                payload.cycleHour,
                runDate,
                payload.newValue,
                false,
                0,
                payload.source
            );
        }
    }

    /**
     * Handle forecast change - trigger immediate scan
     */
    private async handleForecastChange(marketId: string, changeAmount: number): Promise<void> {
        if (this.tradingMode !== 'speed') return;

        const now = Date.now();
        if (this.lastForecastTriggeredCycle && 
            (now - this.lastForecastTriggeredCycle.getTime()) < this.FORECAST_CYCLE_DEBOUNCE_MS) {
            return;
        }
        this.lastForecastTriggeredCycle = new Date(now);

        // Speed mode: immediate execution on forecast changes
        try {
            const signal = this.speedStrategy.detectOpportunity(marketId);
            if (signal) {
                const opp = this.convertSignalToOpportunity(signal);
                if (opp) {
                    logger.info(`Speed arb: ${opp.market.market.question.substring(0, 50)}...`);
                    const result = await this.orderExecutor.executeOpportunity(opp);
                    if (result.executed) {
                        this.stats.tradesExecuted++;
                        this.speedStrategy.markOpportunityCaptured(marketId, opp.forecastValue || 0);
                    }
                }
            }
        } catch (error) {
            rateLimitedLogger.error('forecast-change', 'Forecast change handler error', {
                error: (error as Error).message,
            });
        }
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

            // Execute based on mode
            if (this.tradingMode === 'orchestrated' && this.strategyOrchestrator) {
                // Orchestrated mode: Multi-strategy with adaptive sizing
                await this.runOrchestratedCycle(actionableMarkets);
            } else {
                // Legacy modes
                let signals: EntrySignal[] = [];
                
                if (this.tradingMode === 'speed') {
                    // Speed mode: Fast arbitrage on forecast changes
                    signals = this.speedStrategy.detectOpportunities();
                } else {
                    // Safe mode: Conservative with confidence requirements
                    signals = this.confidenceStrategy.detectOpportunities();
                }

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

                    // Mark captured
                    for (const result of executed) {
                        const opp = result.opportunity;
                        if (opp.forecastValue !== undefined) {
                            if (this.tradingMode === 'speed') {
                                this.speedStrategy.markOpportunityCaptured(opp.market.market.id, opp.forecastValue);
                            } else {
                                this.confidenceStrategy.markOpportunityCaptured(opp.market.market.id, opp.forecastValue);
                            }
                        }
                    }

                    rateLimitedLogger.info('trade-execution',
                        `Executed ${executed.length}/${opportunities.length} trades`);
                }
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
     * Run orchestrated cycle with multi-strategy support
     */
    private async runOrchestratedCycle(markets: ParsedWeatherMarket[]): Promise<void> {
        if (!this.strategyOrchestrator) return;

        // Get signals from orchestrator
        const signals = await this.strategyOrchestrator.analyzeAllMarkets(markets);
        
        if (signals.length === 0) {
            return;
        }

        this.stats.opportunitiesFound += signals.length;

        // Execute top signals in parallel for ~200ms latency reduction
        const topSignals = signals.slice(0, 5);  // Max 5 trades per cycle
        
        const tradePromises = topSignals.map(async (signal) => {
            try {
                // Get current market state
                const state = this.dataStore.getMarketState(signal.opportunity.market.market.id);
                if (!state) return null;

                const entryPrice = signal.opportunity.action === 'buy_yes'
                    ? state.market.yesPrice
                    : state.market.noPrice;

                // Get position size from orchestrator
                const positionSize = signal.opportunity.suggestedSize || config.maxPositionSize;

                // Execute trade
                const result = await this.orderExecutor.executeOpportunity(signal.opportunity);
                
                if (result.executed) {
                    return { signal, entryPrice, positionSize, result };
                }
                return null;
            } catch (error) {
                logger.error(`[BotManager] Error executing orchestrated trade`, {
                    error: (error as Error).message,
                    marketId: signal.opportunity.market.market.id,
                });
                return null;
            }
        });
        
        const results = await Promise.all(tradePromises);
        
        // Process successful executions
        for (const successResult of results.filter((r): r is NonNullable<typeof r> => r !== null)) {
            this.stats.tradesExecuted++;
            this.stats.opportunitiesExecuted++;
            
            // Track in orchestrator
            this.strategyOrchestrator.executeTrade(
                successResult.signal,
                successResult.entryPrice,
                successResult.positionSize
            );

            logger.info(`[BotManager] Executed ${successResult.signal.strategy} trade`, {
                marketId: successResult.signal.opportunity.market.market.id,
                side: successResult.signal.opportunity.action,
                size: successResult.positionSize,
                confidence: successResult.signal.confidence.toFixed(2),
            });
        }

        rateLimitedLogger.info('trade-execution', 
            `Orchestrated mode: ${this.stats.opportunitiesExecuted} trades executed`);
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
     * Set trading mode
     */
    setMode(mode: TradingMode): void {
        this.tradingMode = mode;
        logger.info(`Mode changed to: ${mode.toUpperCase()}`);
    }

    /**
     * Get current mode
     */
    getMode(): TradingMode {
        return this.tradingMode;
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
