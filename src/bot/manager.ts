/**
 * Bot Manager
 * Main orchestrator for the weather arbitrage bot
 * 
 * Integrated Features:
 * - Cross-Market Arbitrage detection and execution
 * - Market Impact Model for slippage estimation
 * - Hybrid Weather Controller for adaptive detection windows
 * - Performance tracking by data source and strategy component
 * - Enhanced order execution with position scaling
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { OrderExecutor } from './order-executor.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';
import { ConfidenceCompressionStrategy } from '../strategy/confidence-compression-strategy.js';
import { EntrySignal } from '../strategy/entry-optimizer.js';
import { DataStore } from '../realtime/data-store.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { FileBasedIngestion } from '../weather/file-based-ingestion.js';
import { HybridWeatherController } from '../realtime/hybrid-weather-controller.js';
import { CrossMarketArbitrage, CorrelatedMarketPair } from '../strategy/cross-market-arbitrage.js';
import { MarketImpactModel, LiquidityProfile } from '../strategy/market-impact.js';
import { EntryOptimizer } from '../strategy/entry-optimizer.js';
import { ExitOptimizer } from '../strategy/exit-optimizer.js';
import { MarketModel } from '../probability/market-model.js';
import { config, validateConfig } from '../config.js';
import { logger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';
import { eventBus } from '../realtime/event-bus.js';
import { forecastStateMachine } from '../realtime/forecast-state-machine.js';

interface BotStats {
    startTime: Date;
    cyclesCompleted: number;
    marketsScanned: number;
    opportunitiesFound: number;
    opportunitiesDetected: number;  // Total detected before filtering
    opportunitiesExecuted: number;
    tradesExecuted: number;
    lastCycleTime?: Date;
    errors: number;
    consideredTrades: number;  // Markets analyzed
    rejectedTrades: number;    // Markets analyzed but not traded
}

/**
 * Performance tracking metrics
 */
interface PerformanceMetrics {
    // Opportunity conversion tracking
    opportunitiesBySource: {
        file: { detected: number; executed: number; pnl: number };
        api: { detected: number; executed: number; pnl: number };
        webhook: { detected: number; executed: number; pnl: number };
    };
    
    // Rejection tracking
    rejectionReasons: {
        marketCaughtUp: number;
        alreadyCaptured: number;
        forecastChangeBelowThreshold: number;
        marketImpactTooHigh: number;
        edgeDegraded: number;
        priceDrift: number;
    };
    
    // Cross-market vs single-market performance
    crossMarketTrades: { count: number; pnl: number };
    singleMarketTrades: { count: number; pnl: number };
    
    // Market impact tracking
    impactEstimates: Array<{
        marketId: string;
        estimatedImpact: number;
        actualImpact: number;
        timestamp: Date;
    }>;
    
    // Data source confidence tracking
    dataSourceConfidence: {
        file: number[];
        api: number[];
        webhook: number[];
    };
}

export class BotManager {
    private weatherScanner: WeatherScanner;
    private tradingClient: TradingClient;
    private opportunityDetector: OpportunityDetector;
    private speedStrategy: SpeedArbitrageStrategy;
    private confidenceStrategy: ConfidenceCompressionStrategy;
    private orderExecutor: OrderExecutor;
    private dataStore: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    
    // New integrated components
    private hybridController: HybridWeatherController | null = null;
    private crossMarketArbitrage: CrossMarketArbitrage;
    private marketImpactModel: MarketImpactModel;
    private entryOptimizer: EntryOptimizer;
    private exitOptimizer: ExitOptimizer;
    private marketModel: MarketModel;

    private isRunning: boolean = false;
    private stats: BotStats;
    private performanceMetrics: PerformanceMetrics;
    private currentDelayTimeout: NodeJS.Timeout | null = null;
    private delayResolve: (() => void) | null = null;
    
    // Track opportunities for cross-market analysis
    private pendingOpportunities: Map<string, TradingOpportunity> = new Map();
    
    // Cycle tracking
    private lastCycleStart: Date = new Date();
    private cycleDurations: number[] = [];
    
    // Forecast-triggered cycle guards
    private isCycleRunning: boolean = false;
    private lastForecastTriggeredCycle: Date | null = null;
    private readonly FORECAST_CYCLE_DEBOUNCE_MS = 5000; // 5 second debounce

    constructor() {
        this.weatherScanner = new WeatherScanner();
        this.tradingClient = new TradingClient();
        this.dataStore = new DataStore();
        this.opportunityDetector = new OpportunityDetector(this.dataStore);
        this.speedStrategy = new SpeedArbitrageStrategy(this.dataStore);
        this.confidenceStrategy = new ConfidenceCompressionStrategy(this.dataStore);
        this.orderExecutor = new OrderExecutor(this.tradingClient, this.dataStore);
        this.priceTracker = new PriceTracker(this.dataStore);
        this.forecastMonitor = new ForecastMonitor(this.dataStore);
        
        // Initialize new components
        this.marketModel = new MarketModel(this.dataStore);
        this.marketImpactModel = new MarketImpactModel();
        this.crossMarketArbitrage = new CrossMarketArbitrage();
        this.entryOptimizer = new EntryOptimizer(
            this.marketModel,
            this.marketImpactModel,
            config.maxPositionSize
        );
        this.exitOptimizer = new ExitOptimizer(this.marketModel);
        
        // Initialize hybrid controller (will be set up in initialize())
        this.hybridController = null;

        this.stats = {
            startTime: new Date(),
            cyclesCompleted: 0,
            marketsScanned: 0,
            opportunitiesFound: 0,
            opportunitiesDetected: 0,
            opportunitiesExecuted: 0,
            tradesExecuted: 0,
            errors: 0,
            consideredTrades: 0,
            rejectedTrades: 0,
        };
        
        this.performanceMetrics = {
            opportunitiesBySource: {
                file: { detected: 0, executed: 0, pnl: 0 },
                api: { detected: 0, executed: 0, pnl: 0 },
                webhook: { detected: 0, executed: 0, pnl: 0 },
            },
            rejectionReasons: {
                marketCaughtUp: 0,
                alreadyCaptured: 0,
                forecastChangeBelowThreshold: 0,
                marketImpactTooHigh: 0,
                edgeDegraded: 0,
                priceDrift: 0,
            },
            crossMarketTrades: { count: 0, pnl: 0 },
            singleMarketTrades: { count: 0, pnl: 0 },
            impactEstimates: [],
            dataSourceConfidence: {
                file: [],
                api: [],
                webhook: [],
            },
        };
    }

    /**
     * Initialize the bot
     */
    async initialize(): Promise<void> {
        logger.info('='.repeat(60));
        logger.info('Polymarket Weather Arbitrage Bot');
        logger.info('Integrated v2 - Cross-Market & Market Impact Aware');
        logger.info('='.repeat(60));

        validateConfig();

        logger.info('Configuration:', {
            simulationMode: config.simulationMode,
            maxPositionSize: config.maxPositionSize,
            minEdgeThreshold: `${(config.minEdgeThreshold * 100).toFixed(0)}%`,
            pollIntervalMs: config.pollIntervalMs,
            enableFileBasedIngestion: config.ENABLE_FILE_BASED_INGESTION,
            enableCrossMarketArbitrage: config.ENABLE_CROSS_MARKET_ARBITRAGE,
            enableMarketImpactModel: config.ENABLE_MARKET_IMPACT_MODEL,
            enableAdaptiveDetectionWindows: config.ENABLE_ADAPTIVE_DETECTION_WINDOWS,
        });

        await this.tradingClient.initialize();

        // C7: Propagate skipPriceCheck setting from config
        if (config.skipPriceCheck) {
            this.speedStrategy.setSkipPriceCheck(true);
        }

        // Initialize hybrid controller for file-based ingestion and/or adaptive detection windows
        if (config.ENABLE_FILE_BASED_INGESTION || config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
            try {
                this.hybridController = new HybridWeatherController(
                    forecastStateMachine,
                    this.dataStore
                );

                // Q6: Wire HybridWeatherController outputs
                // Trigger immediate scan cycle when file-confirmed data arrives
                this.hybridController.on('fileConfirmed', (payload: { model: string; cycleHour: number; cityData: unknown[] }) => {
                    logger.info(`📁 File-confirmed data received (${payload.model} ${payload.cycleHour}Z, ${(payload.cityData as unknown[]).length} cities) — triggering immediate scan`);
                    // Run a scan cycle immediately to capture opportunities from fresh file data
                    if (this.isRunning && !this.isCycleRunning) {
                        this.runCycle().catch(err => {
                            logger.error('Error in file-confirmed triggered scan cycle', { error: (err as Error).message });
                        });
                    }
                });

                this.hybridController.on('modeTransition', (transition: { from: string; to: string; reason: string }) => {
                    logger.info(`🔄 HybridController: ${transition.from} → ${transition.to} (${transition.reason})`);
                });
            } catch (error) {
                this.hybridController = null;
                logger.warn('Failed to initialize HybridWeatherController; continuing without it', {
                    error: (error as Error).message,
                });
            }
        }

        // Start PriceTracker (handles market scanning and WS updates)
        await this.priceTracker.start(this.weatherScanner, 60000);

        // C4: Wire FORECAST_CHANGE events to feed ConfidenceCompressionStrategy run history
        // This is CRITICAL for the stability-based strategy to receive model run data
        eventBus.on('FORECAST_CHANGE', (event) => {
            if (event.type === 'FORECAST_CHANGE') {
                const { cityId, variable, newValue, model, cycleHour, timestamp, source } = event.payload;
                const runDate = new Date(timestamp);
                const isTemp = variable === 'TEMPERATURE';
                const isPrecip = variable === 'PRECIPITATION';

                if (isTemp) {
                    this.confidenceStrategy.processModelRun(
                        cityId, model, cycleHour, runDate,
                        newValue, false, 0, source
                    );
                } else if (isPrecip) {
                    this.confidenceStrategy.processModelRun(
                        cityId, model, cycleHour, runDate,
                        0, newValue > 0.1, newValue, source
                    );
                }
            }
        });

        // Setup forecast monitor
        this.forecastMonitor.onForecastChanged = async (marketId, change) => {
            // FAST PATH: Handle specific change immediately
            await this.handleForecastChange(marketId, change);

            logger.info(`🚨 INTERRUPT: Significant forecast change detected! Triggering full scan.`);
            // Interrupt current delay to run cycle immediately
            if (this.currentDelayTimeout) {
                clearTimeout(this.currentDelayTimeout);
                this.currentDelayTimeout = null;
                if (this.delayResolve) {
                    this.delayResolve();
                    this.delayResolve = null;
                }
            }
            
            try {
                await this.runCycle();
            } catch (error) {
                logger.error('Error in forecast-triggered cycle', { error: (error as Error).message });
            }
        };
    }

    /**
     * Handle a specific forecast change event (Fast Path)
     */
    async handleForecastChange(marketId: string, changeAmount: number): Promise<void> {
        try {
            logger.info(`⚡ FAST PATH: Checking speed arbitrage for ${marketId} (change: ${changeAmount.toFixed(1)})`);
            
            const signal = this.speedStrategy.detectOpportunity(marketId);
            
            if (signal) {
                const opp = this.convertSignalToOpportunity(signal);
                if (opp) {
                    logger.info(`🚀 FAST PATH: Executing Speed Arb trade for ${opp.market.market.question.substring(0, 40)}...`);
                    
                    const result = await this.orderExecutor.executeOpportunity(opp);
                    
                    if (result.executed && opp.forecastValue !== undefined && opp.action !== 'none') {
                        this.stats.tradesExecuted++;
                        this.speedStrategy.markOpportunityCaptured(marketId, opp.forecastValue);
                        this.opportunityDetector.markOpportunityCaptured(marketId, opp.forecastValue, opp.action);
                    }
                }
            }
        } catch (error) {
            logger.error(`Error in fast path execution for ${marketId}`, { error: (error as Error).message });
        }
    }

    /**
     * Run a single scan cycle
     */
    async runCycle(): Promise<void> {
        // Guard: prevent concurrent cycles
        if (this.isCycleRunning) {
            logger.debug('Cycle already running, skipping');
            return;
        }
        this.isCycleRunning = true;
        
        const cycleStart = new Date();
        this.lastCycleStart = cycleStart;
        logger.info('Starting scan cycle...');

        try {
            // Log current detection mode if adaptive windows are enabled
            if (config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
                if (!this.hybridController) {
                    logger.warn('Adaptive detection windows enabled but HybridWeatherController is not initialized');
                } else {
                    const mode = this.hybridController.getCurrentMode();
                    const detectionWindow = this.hybridController.getCurrentDetectionWindow();
                    logger.debug(`Detection mode: ${mode}`, {
                        window: detectionWindow ? `${detectionWindow.model} ${detectionWindow.cycleHour}Z` : 'none',
                        earlyDetection: this.hybridController.getState().earlyDetectionActive,
                    });
                }
            }

            // Step 1: Get markets from DataStore (maintained by PriceTracker)
            const allMarkets = this.dataStore.getAllMarkets();

            if (allMarkets.length === 0) {
                logger.info('No markets in store yet, waiting...');
                return;
            }

            const actionableMarkets = this.weatherScanner.filterActionableMarkets(allMarkets);

            this.stats.marketsScanned += allMarkets.length;

            logger.info(`Analyzing ${allMarkets.length} weather markets, ${actionableMarkets.length} actionable`);

            if (actionableMarkets.length === 0) {
                logger.info('No actionable markets found this cycle');
                return;
            }

            // Step 2: Analyze markets for opportunities
            // Run all three strategies: Value Arb, Speed Arb, and Confidence Compression
            logger.info('Analyzing markets for opportunities...');
            
            const [valueOpportunities, speedSignals, confidenceSignals] = await Promise.all([
                this.opportunityDetector.analyzeMarkets(actionableMarkets),
                Promise.resolve(this.speedStrategy.detectOpportunities()),
                Promise.resolve(this.confidenceStrategy.detectOpportunities())
            ]);

            // Convert speed signals to TradingOpportunities
            const speedOpportunities = speedSignals
                .map(signal => this.convertSignalToOpportunity(signal))
                .filter((opp): opp is TradingOpportunity => opp !== null);

            // C4: Convert confidence compression signals to TradingOpportunities
            const confidenceOpportunities = confidenceSignals
                .map(signal => this.convertSignalToOpportunity(signal))
                .filter((opp): opp is TradingOpportunity => opp !== null);

            if (confidenceSignals.length > 0) {
                logger.info(`🔒 Confidence Compression: ${confidenceSignals.length} signals detected`);
            }

            // Merge opportunities: Speed Arb > Confidence > Value Arb (priority order)
            const mergedOpportunities = this.mergeOpportunities(
                this.mergeOpportunities(valueOpportunities, confidenceOpportunities),
                speedOpportunities
            );

            // Track considered and rejected trades
            this.stats.consideredTrades += mergedOpportunities.length;
            const rejectedCount = mergedOpportunities.filter(opp => opp.action === 'none').length;
            this.stats.rejectedTrades += rejectedCount;

            // Filter to only actionable opportunities for execution
            const actionableOpportunities = mergedOpportunities.filter(opp => opp.action !== 'none');

            this.stats.opportunitiesFound += actionableOpportunities.length;

            if (mergedOpportunities.length === 0) {
                logger.info('No trading opportunities found this cycle');
                logger.debug('Opportunity rejection stats', this.opportunityDetector.getRejectionStats());
            } else {
                logger.info(`Found ${mergedOpportunities.length} trading opportunities (${speedOpportunities.length} Speed Arb, ${valueOpportunities.length} Value Arb), ${rejectedCount} rejected`);
                this.logOpportunities(mergedOpportunities);
            }

            // Step 3: Execute trades (only actionable ones)
            if (actionableOpportunities.length > 0) {
                logger.info('Executing trades...');
                const results = await this.orderExecutor.executeOpportunities(actionableOpportunities);

                const successfulTrades = results.filter(r => r.executed);
                this.stats.tradesExecuted += successfulTrades.length;
                this.stats.opportunitiesExecuted += successfulTrades.length;

                // Track performance metrics
                // this.trackExecutionResults(results, opportunities, correlatedOpportunities);

                // Mark successful trades as captured
                for (const result of successfulTrades) {
                    const opp = result.opportunity;
                    if (opp.forecastValue !== undefined && (opp.action === 'buy_yes' || opp.action === 'buy_no')) {
                        // Notify all strategies
                        this.opportunityDetector.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue,
                            opp.action
                        );
                        this.speedStrategy.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue
                        );
                        this.confidenceStrategy.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue
                        );
                    }
                }

                logger.info(`Executed ${successfulTrades.length}/${actionableOpportunities.length} trades`);
            }

            // Step 6: Update rejection stats from opportunity detector
            this.updateRejectionStats();

        } catch (error) {
            this.stats.errors++;
            logger.error('Error in scan cycle', { error: (error as Error).message });
        } finally {
            this.isCycleRunning = false;

            // S2: Always increment cycle counter and track duration, even on early return
            this.stats.cyclesCompleted++;
            this.stats.lastCycleTime = cycleStart;

            const cycleDuration = Date.now() - cycleStart.getTime();
            this.cycleDurations.push(cycleDuration);
            
            // Keep only last 100 cycle durations for averaging
            if (this.cycleDurations.length > 100) {
                this.cycleDurations.shift();
            }
            
            logger.info(`Cycle completed in ${(cycleDuration / 1000).toFixed(1)}s`);
        }
    }

    /**
     * Merge opportunities from different strategies, removing duplicates
     */
    private mergeOpportunities(valueArb: TradingOpportunity[], speedArb: TradingOpportunity[]): TradingOpportunity[] {
        const map = new Map<string, TradingOpportunity>();

        // Add Value Arb first
        for (const opp of valueArb) {
            map.set(opp.market.market.id, opp);
        }

        // Add Speed Arb (overwriting Value Arb if duplicate - assume Speed is fresher/better)
        for (const opp of speedArb) {
            if (map.has(opp.market.market.id)) {
                logger.info(`⚡ Upgrading opportunity to SPEED ARB: ${opp.market.market.question.substring(0, 40)}...`);
            }
            map.set(opp.market.market.id, opp);
        }

        return Array.from(map.values());
    }

    /**
     * Convert EntrySignal (from Speed Arb) to TradingOpportunity (for OrderExecutor)
     */
    private convertSignalToOpportunity(signal: EntrySignal): TradingOpportunity | null {
        const marketState = this.dataStore.getMarketState(signal.marketId);
        if (!marketState) return null;

        const market = marketState.market;
        const forecast = marketState.lastForecast;

        // S7: Use the stored forecast probability if available, instead of
        // approximating by adding edge (which already has costs subtracted) to price
        const storedProb = forecast?.probability;
        const marketYesProb = market.yesPrice;
        let forecastProbability: number;
        if (storedProb !== undefined) {
            forecastProbability = storedProb;
        } else {
            // Fallback: reconstruct from edge (raw edge = prob - price)
            forecastProbability = signal.side === 'yes'
                ? marketYesProb + Math.abs(signal.estimatedEdge)
                : marketYesProb - Math.abs(signal.estimatedEdge);
        }
        forecastProbability = Math.max(0.01, Math.min(0.99, forecastProbability));

        return {
            market: market,
            forecastProbability,
            marketProbability: marketYesProb,
            edge: forecastProbability - marketYesProb, // Positive = underpriced YES
            action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
            confidence: signal.confidence,
            reason: `⚡ SPEED ARB: ${signal.reason}`,
            weatherDataSource: 'noaa',
            forecastValue: forecast?.forecastValue,
            forecastValueUnit: market.thresholdUnit || '°F',
            isGuaranteed: signal.isGuaranteed,
            snapshotYesPrice: market.yesPrice,
            snapshotNoPrice: market.noPrice,
            snapshotTimestamp: new Date()
        };
    }

    /**
     * Update rejection stats from opportunity detector
     */
    private updateRejectionStats(): void {
        const stats = this.opportunityDetector.getRejectionStats();
        this.performanceMetrics.rejectionReasons.marketCaughtUp = stats.marketCaughtUp;
        this.performanceMetrics.rejectionReasons.alreadyCaptured = stats.alreadyCaptured;
        this.performanceMetrics.rejectionReasons.forecastChangeBelowThreshold = stats.forecastChangeBelowThreshold;
    }

    /**
     * Start the bot (continuous polling)
     */
    async start(): Promise<void> {
        this.isRunning = true;
        this.forecastMonitor.start(); // Start forecast monitoring
        
        // Start hybrid controller if initialized
        if (this.hybridController) {
            this.hybridController.start();
            if (config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
                logger.info('Hybrid Weather Controller started with adaptive detection windows');
            } else {
                logger.info('Hybrid Weather Controller started');
            }
        }
        
        logger.info('Bot started - entering polling loop');
        logger.info(`Poll interval: ${config.pollIntervalMs / 1000}s`);

        while (this.isRunning) {
            await this.runCycle();

            if (this.isRunning) {
                logger.info(`Next cycle in ${config.pollIntervalMs / 1000}s...`);
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
        
        // Stop hybrid controller if running
        if (this.hybridController) {
            this.hybridController.stop();
        }

        // Interrupt delay if active
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
     * Get performance metrics
     */
    getPerformanceMetrics(): PerformanceMetrics {
        return { ...this.performanceMetrics };
    }

    /**
     * Get hybrid controller status
     */
    getHybridControllerStatus() {
        if (!this.hybridController) {
            return { enabled: false };
        }
        if (!config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
            return { enabled: false };
        }
        return this.hybridController.getStatusReport();
    }

    /**
     * Get cross-market arbitrage stats
     */
    getCrossMarketStats() {
        if (!config.ENABLE_CROSS_MARKET_ARBITRAGE) {
            return { enabled: false };
        }
        return this.crossMarketArbitrage.getStats();
    }

    /**
     * Log opportunities in a readable format
     */
    private logOpportunities(opportunities: TradingOpportunity[]): void {
        for (const opp of opportunities) {
            const marketQuestion = opp.market.market.question.substring(0, 60);
            logger.info(`Opportunity: ${marketQuestion}...`, {
                action: opp.action,
                edge: `${(opp.edge * 100).toFixed(1)}%`,
                marketPrice: `${(opp.marketProbability * 100).toFixed(1)}%`,
                forecastProb: `${(opp.forecastProbability * 100).toFixed(1)}%`,
                confidence: `${(opp.confidence * 100).toFixed(0)}%`,
                reason: opp.reason,
            });
        }
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
