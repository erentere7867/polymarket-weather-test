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
    private orderExecutor: OrderExecutor;
    private dataStore: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    
    // New integrated components
    private hybridController: HybridWeatherController;
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
        this.opportunityDetector = new OpportunityDetector();
        this.orderExecutor = new OrderExecutor(this.tradingClient);
        this.dataStore = new DataStore();
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
        this.hybridController = null as any; // Will be initialized after state machine setup

        this.stats = {
            startTime: new Date(),
            cyclesCompleted: 0,
            marketsScanned: 0,
            opportunitiesFound: 0,
            opportunitiesDetected: 0,
            opportunitiesExecuted: 0,
            tradesExecuted: 0,
            errors: 0,
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

        // Start PriceTracker (handles market scanning and WS updates)
        await this.priceTracker.start(this.weatherScanner, 60000);

        // Initialize and start hybrid controller
        const { ForecastStateMachine } = await import('../realtime/forecast-state-machine.js');
        const stateMachine = new ForecastStateMachine();
        this.hybridController = new HybridWeatherController(
            stateMachine,
            this.dataStore
        );
        
        // NOTE: Forecast change triggers are consolidated in setupCrossMarketListeners()
        // via eventBus.on('FORECAST_CHANGED') which has proper debouncing and guards.
        // The ForecastMonitor.onForecastChanged callback is NOT used to avoid duplicate triggers.

        // Setup file-based ingestion event handlers via global event bus
        eventBus.on('FILE_CONFIRMED', (event) => {
            if (event.type === 'FILE_CONFIRMED') {
                const data = event.payload;
                logger.info(`[BotManager] File confirmed: ${data.model} ${String(data.cycleHour).padStart(2, '0')}Z`);
                this.trackDataSourceConfidence('file', 1.0);
            }
        });

        // Setup hybrid controller event listeners
        this.setupHybridControllerListeners();

        // Setup cross-market arbitrage event listeners
        this.setupCrossMarketListeners();

        logger.info('Bot initialized successfully');
    }

    /**
     * Setup hybrid controller event listeners
     */
    private setupHybridControllerListeners(): void {
        if (!config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) return;

        // Listen for early detection triggers
        this.hybridController.on('earlyDetectionTriggered', (trigger) => {
            logger.info(`🚨 Early detection triggered: ${trigger.triggerSource} (confidence: ${(trigger.confidence * 100).toFixed(0)}%)`);
        });

        // Listen for mode transitions
        this.hybridController.on('modeTransition', (transition) => {
            logger.debug(`Mode transition: ${transition.from} → ${transition.to}`, {
                reason: transition.reason,
                duration: Date.now() - this.hybridController.getCurrentModeDuration(),
            });
        });

        // Listen for forecast batch updates
        this.hybridController.on('FORECAST_BATCH_UPDATED', (data) => {
            logger.debug(`Forecast batch updated: ${data.totalCities} cities from ${data.provider}`);
        });
    }

    /**
     * Setup cross-market arbitrage listeners and forecast change triggers
     */
    private setupCrossMarketListeners(): void {
        // Listen for forecast updates - ALWAYS trigger cycles, not just for cross-market
        eventBus.on('FORECAST_CHANGED', async (event) => {
            const payload = event.payload as {
                cityId: string;
                newValue: number;
                changeAmount?: number;
                source?: string;
                confidence?: number;
            };
            
            // Update cross-market arbitrage data if enabled
            if (config.ENABLE_CROSS_MARKET_ARBITRAGE && payload.cityId && payload.newValue !== undefined) {
                this.crossMarketArbitrage.updateForecast(
                    payload.cityId,
                    payload.newValue,
                    payload.confidence || 0.5
                );
            }
            
            // CRITICAL: Trigger immediate trading cycle on forecast change
            // This ensures forecast changes are immediately analyzed for opportunities
            if (!this.isRunning) return;
            
            // Debounce: don't trigger if we just triggered recently
            const now = Date.now();
            if (this.lastForecastTriggeredCycle && 
                (now - this.lastForecastTriggeredCycle.getTime()) < this.FORECAST_CYCLE_DEBOUNCE_MS) {
                logger.debug(`Debouncing forecast-triggered cycle (${payload.cityId})`);
                return;
            }
            
            // Guard: don't trigger if cycle already running
            if (this.isCycleRunning) {
                logger.debug(`Skipping forecast-triggered cycle: cycle already running (${payload.cityId})`);
                return;
            }
            
            logger.info(`🚀 FORECAST_CHANGED triggering immediate trading cycle for ${payload.cityId}`);
            this.lastForecastTriggeredCycle = new Date();
            
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
        });
    }

    /**
     * Run a single scan cycle with integrated components
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
                const mode = this.hybridController.getCurrentMode();
                const detectionWindow = this.hybridController.getCurrentDetectionWindow();
                logger.debug(`Detection mode: ${mode}`, {
                    window: detectionWindow ? `${detectionWindow.model} ${detectionWindow.cycleHour}Z` : 'none',
                    earlyDetection: this.hybridController.getState().earlyDetectionActive,
                });
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
            logger.info('Analyzing markets for opportunities...');
            const opportunities = await this.opportunityDetector.analyzeMarkets(actionableMarkets);
            this.stats.opportunitiesDetected += opportunities.length;

            // Step 3: Detect cross-market opportunities if enabled
            let correlatedOpportunities: TradingOpportunity[] = [];
            if (config.ENABLE_CROSS_MARKET_ARBITRAGE && opportunities.length > 0) {
                correlatedOpportunities = this.detectCorrelatedOpportunities(opportunities, allMarkets);
                if (correlatedOpportunities.length > 0) {
                    logger.info(`Found ${correlatedOpportunities.length} cross-market opportunities`);
                }
            }

            // Combine single-market and cross-market opportunities
            const allOpportunities = [...opportunities, ...correlatedOpportunities];
            
            // Step 4: Apply market impact analysis if enabled
            let finalOpportunities = allOpportunities;
            if (config.ENABLE_MARKET_IMPACT_MODEL) {
                finalOpportunities = await this.applyMarketImpactAnalysis(allOpportunities);
            }

            this.stats.opportunitiesFound += finalOpportunities.length;

            if (finalOpportunities.length === 0) {
                logger.info('No trading opportunities found this cycle');
            } else {
                logger.info(`Found ${finalOpportunities.length} trading opportunities (${opportunities.length} single-market, ${correlatedOpportunities.length} cross-market)`);
                this.logOpportunities(finalOpportunities);
            }

            // Step 5: Execute trades
            if (finalOpportunities.length > 0) {
                logger.info('Executing trades...');
                const results = await this.orderExecutor.executeOpportunities(finalOpportunities);

                const successfulTrades = results.filter(r => r.executed);
                this.stats.tradesExecuted += successfulTrades.length;
                this.stats.opportunitiesExecuted += successfulTrades.length;

                // Track performance metrics
                this.trackExecutionResults(results, opportunities, correlatedOpportunities);

                // Mark successful trades as captured
                for (const result of successfulTrades) {
                    const opp = result.opportunity;
                    if (opp.forecastValue !== undefined && (opp.action === 'buy_yes' || opp.action === 'buy_no')) {
                        this.opportunityDetector.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue,
                            opp.action
                        );
                    }
                }

                logger.info(`Executed ${successfulTrades.length}/${finalOpportunities.length} trades`);
            }

            // Step 6: Update rejection stats from opportunity detector
            this.updateRejectionStats();

        } catch (error) {
            this.stats.errors++;
            logger.error('Error in scan cycle', { error: (error as Error).message });
        } finally {
            this.isCycleRunning = false;
        }

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

    /**
     * Detect correlated opportunities using cross-market arbitrage
     */
    private detectCorrelatedOpportunities(
        opportunities: TradingOpportunity[],
        allMarkets: ParsedWeatherMarket[]
    ): TradingOpportunity[] {
        const correlatedOpps: TradingOpportunity[] = [];

        for (const opp of opportunities) {
            if (!opp.market.city) continue;

            // Find correlated market pairs
            const correlatedPairs = this.crossMarketArbitrage.findCorrelatedMarkets(
                opp.market,
                allMarkets,
                {
                    marketId: opp.market.market.id,
                    side: opp.action === 'buy_yes' ? 'yes' : 'no',
                    rawEdge: opp.edge,
                    adjustedEdge: opp.edge,
                    confidence: opp.confidence,
                    KellyFraction: 0,
                    reason: opp.reason,
                    isGuaranteed: opp.isGuaranteed || false,
                }
            );

            for (const pair of correlatedPairs) {
                // Only exploit high-quality correlations
                if (pair.lagExploitationPotential < 0.5) continue;

                // Create a correlated opportunity
                const correlatedOpp: TradingOpportunity = {
                    ...opp,
                    market: pair.correlatedMarket,
                    reason: `${opp.reason} (Cross-Market: ${pair.correlation.correlationCoefficient.toFixed(2)} correlation)`,
                    confidence: opp.confidence * pair.correlation.confidence,
                    // Adjust edge based on correlation
                    edge: opp.edge * pair.correlation.correlationCoefficient,
                };

                correlatedOpps.push(correlatedOpp);
            }
        }

        return correlatedOpps;
    }

    /**
     * Apply market impact analysis to opportunities
     */
    private async applyMarketImpactAnalysis(
        opportunities: TradingOpportunity[]
    ): Promise<TradingOpportunity[]> {
        const analyzedOpps: TradingOpportunity[] = [];

        for (const opp of opportunities) {
            // Build liquidity profile from market data
            // Use market volume from market object or default to $50k
            const marketVolume = (opp.market.market as any).volume
                ? parseFloat((opp.market.market as any).volume)
                : 50000;
            const liquidity: LiquidityProfile = {
                dailyVolume: marketVolume,
                averageTradeSize: marketVolume / 100,
                bidDepth: opp.market.yesPrice * marketVolume * 0.1,
                askDepth: opp.market.noPrice * marketVolume * 0.1,
                spread: Math.abs(opp.market.yesPrice + opp.market.noPrice - 1),
                volatility: this.marketModel.getPriceVelocity(opp.market.market.id, 'yes'),
            };

            // Calculate position size
            const positionSize = this.calculatePositionSize(opp);

            // Estimate market impact
            const impactEstimate = this.marketImpactModel.estimateCompleteImpact(
                positionSize,
                liquidity
            );

            // Log impact estimate for learning
            this.performanceMetrics.impactEstimates.push({
                marketId: opp.market.market.id,
                estimatedImpact: impactEstimate.totalCost,
                actualImpact: 0, // Will be updated after execution
                timestamp: new Date(),
            });

            // Keep only last 100 impact estimates
            if (this.performanceMetrics.impactEstimates.length > 100) {
                this.performanceMetrics.impactEstimates.shift();
            }

            // Check if impact is acceptable
            if (impactEstimate.totalCost > config.MAX_MARKET_IMPACT_THRESHOLD) {
                logger.warn(`Skipping opportunity due to high market impact`, {
                    market: opp.market.market.question.substring(0, 50),
                    impact: `${(impactEstimate.totalCost * 100).toFixed(2)}%`,
                    threshold: `${(config.MAX_MARKET_IMPACT_THRESHOLD * 100).toFixed(2)}%`,
                });
                this.performanceMetrics.rejectionReasons.marketImpactTooHigh++;
                continue;
            }

            // Adjust opportunity with impact-adjusted edge
            const adjustedOpp: TradingOpportunity = {
                ...opp,
                edge: opp.edge - impactEstimate.totalCost,
                reason: `${opp.reason} (Impact: ${(impactEstimate.totalCost * 100).toFixed(2)}%)`,
            };

            analyzedOpps.push(adjustedOpp);
        }

        return analyzedOpps;
    }

    /**
     * Calculate position size for an opportunity
     */
    private calculatePositionSize(opportunity: TradingOpportunity): number {
        const maxSize = config.maxPositionSize;
        const edge = Math.abs(opportunity.edge);
        const confidence = opportunity.confidence;

        // Kelly fraction = edge * confidence
        const kellyFraction = edge * confidence;
        const halfKelly = kellyFraction * 0.5;

        // Calculate USDC amount
        const usdcAmount = maxSize * Math.min(halfKelly * 10, 1);

        // Calculate number of shares
        const price = opportunity.action === 'buy_yes'
            ? opportunity.market.yesPrice
            : opportunity.market.noPrice;

        if (price <= 0) return 0;

        const shares = Math.floor(usdcAmount / price);

        return Math.max(1, Math.min(shares, Math.floor(maxSize / price)));
    }

    /**
     * Track execution results for performance metrics
     */
    private trackExecutionResults(
        results: Array<{ opportunity: TradingOpportunity; executed: boolean; error?: string }>,
        singleMarketOpps: TradingOpportunity[],
        crossMarketOpps: TradingOpportunity[]
    ): void {
        for (const result of results) {
            if (!result.executed && result.error) {
                // Track rejection reasons
                if (result.error.includes('edge')) {
                    this.performanceMetrics.rejectionReasons.edgeDegraded++;
                } else if (result.error.includes('drift')) {
                    this.performanceMetrics.rejectionReasons.priceDrift++;
                }
            }

            // Track cross-market vs single-market
            const isCrossMarket = crossMarketOpps.some(
                o => o.market.market.id === result.opportunity.market.market.id
            );

            if (result.executed) {
                if (isCrossMarket) {
                    this.performanceMetrics.crossMarketTrades.count++;
                } else {
                    this.performanceMetrics.singleMarketTrades.count++;
                }
            }

            // Track by data source
            const source = result.opportunity.weatherDataSource || 'api';
            if (source.includes('file') || source.includes('s3')) {
                this.performanceMetrics.opportunitiesBySource.file.executed += result.executed ? 1 : 0;
            } else if (source.includes('webhook')) {
                this.performanceMetrics.opportunitiesBySource.webhook.executed += result.executed ? 1 : 0;
            } else {
                this.performanceMetrics.opportunitiesBySource.api.executed += result.executed ? 1 : 0;
            }
        }
    }

    /**
     * Update rejection stats from opportunity detector
     */
    private updateRejectionStats(): void {
        const rejectionStats = this.opportunityDetector.getRejectionStats();
        this.performanceMetrics.rejectionReasons.marketCaughtUp += rejectionStats.marketCaughtUp;
        this.performanceMetrics.rejectionReasons.alreadyCaptured += rejectionStats.alreadyCaptured;
        this.performanceMetrics.rejectionReasons.forecastChangeBelowThreshold += rejectionStats.forecastChangeBelowThreshold;
    }

    /**
     * Track data source confidence
     */
    private trackDataSourceConfidence(source: 'file' | 'api' | 'webhook', confidence: number): void {
        this.performanceMetrics.dataSourceConfidence[source].push(confidence);
        
        // Keep only last 100 confidence scores
        if (this.performanceMetrics.dataSourceConfidence[source].length > 100) {
            this.performanceMetrics.dataSourceConfidence[source].shift();
        }
    }

    /**
     * Start the bot (continuous polling)
     */
    async start(): Promise<void> {
        this.isRunning = true;
        this.forecastMonitor.start(); // Start forecast monitoring
        
        // Start hybrid controller if adaptive windows enabled
        if (config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
            this.hybridController.start();
            logger.info('Hybrid Weather Controller started with adaptive detection windows');
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
        if (config.ENABLE_ADAPTIVE_DETECTION_WINDOWS) {
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
