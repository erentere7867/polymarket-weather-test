/**
 * Bot Manager
 * Main orchestrator for the weather arbitrage bot
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { OrderExecutor } from './order-executor.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';
import { EntrySignal } from '../strategy/entry-optimizer.js';
import { DataStore } from '../realtime/data-store.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { config, validateConfig } from '../config.js';
import { logger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';

interface BotStats {
    startTime: Date;
    cyclesCompleted: number;
    marketsScanned: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    lastCycleTime?: Date;
    errors: number;
}

export class BotManager {
    private weatherScanner: WeatherScanner;
    private tradingClient: TradingClient;
    private opportunityDetector: OpportunityDetector;
    private speedStrategy: SpeedArbitrageStrategy;
    private orderExecutor: OrderExecutor;
    private dataStore: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;

    private isRunning: boolean = false;
    private stats: BotStats;
    private currentDelayTimeout: NodeJS.Timeout | null = null;
    private delayResolve: (() => void) | null = null;

    constructor() {
        this.weatherScanner = new WeatherScanner();
        this.tradingClient = new TradingClient();
        this.opportunityDetector = new OpportunityDetector();
        this.dataStore = new DataStore();
        this.speedStrategy = new SpeedArbitrageStrategy(this.dataStore);
        this.orderExecutor = new OrderExecutor(this.tradingClient);
        this.priceTracker = new PriceTracker(this.dataStore);
        this.forecastMonitor = new ForecastMonitor(this.dataStore);

        this.stats = {
            startTime: new Date(),
            cyclesCompleted: 0,
            marketsScanned: 0,
            opportunitiesFound: 0,
            tradesExecuted: 0,
            errors: 0,
        };
    }

    /**
     * Initialize the bot
     */
    async initialize(): Promise<void> {
        logger.info('='.repeat(60));
        logger.info('Polymarket Weather Arbitrage Bot');
        logger.info('='.repeat(60));

        validateConfig();

        logger.info('Configuration:', {
            simulationMode: config.simulationMode,
            maxPositionSize: config.maxPositionSize,
            minEdgeThreshold: `${(config.minEdgeThreshold * 100).toFixed(0)}%`,
            pollIntervalMs: config.pollIntervalMs,
        });

        await this.tradingClient.initialize();
        
        // Start PriceTracker (handles market scanning and WS updates)
        await this.priceTracker.start(this.weatherScanner, 60000);

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
        };

        logger.info('Bot initialized successfully');
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
        const cycleStart = new Date();
        logger.info('Starting scan cycle...');

        try {
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
            // Run both strategies: Standard Value Arb (OpportunityDetector) AND Speed Arb (SpeedArbitrageStrategy)
            logger.info('Analyzing markets for opportunities...');
            
            const [valueOpportunities, speedSignals] = await Promise.all([
                this.opportunityDetector.analyzeMarkets(actionableMarkets),
                Promise.resolve(this.speedStrategy.detectOpportunities()) // Synchronous but run in flow
            ]);

            // Convert speed signals to TradingOpportunities
            const speedOpportunities = speedSignals
                .map(signal => this.convertSignalToOpportunity(signal))
                .filter((opp): opp is TradingOpportunity => opp !== null);

            // Merge opportunities, prioritizing Speed Arb
            const mergedOpportunities = this.mergeOpportunities(valueOpportunities, speedOpportunities);

            this.stats.opportunitiesFound += mergedOpportunities.length;

            if (mergedOpportunities.length === 0) {
                logger.info('No trading opportunities found this cycle');
            } else {
                logger.info(`Found ${mergedOpportunities.length} trading opportunities (${speedOpportunities.length} Speed Arb, ${valueOpportunities.length} Value Arb)`);
                this.logOpportunities(mergedOpportunities);
            }

            // Step 3: Execute trades
            if (mergedOpportunities.length > 0) {
                logger.info('Executing trades...');
                const results = await this.orderExecutor.executeOpportunities(mergedOpportunities);

                const successfulTrades = results.filter(r => r.executed);
                this.stats.tradesExecuted += successfulTrades.length;

                // Mark successful trades as captured
                for (const result of successfulTrades) {
                    const opp = result.opportunity;
                    if (opp.forecastValue !== undefined && (opp.action === 'buy_yes' || opp.action === 'buy_no')) {
                        // Notify both strategies
                        this.opportunityDetector.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue,
                            opp.action
                        );
                        this.speedStrategy.markOpportunityCaptured(
                            opp.market.market.id,
                            opp.forecastValue
                        );
                    }
                }

                logger.info(`Executed ${successfulTrades.length}/${mergedOpportunities.length} trades`);
            }

        } catch (error) {
            this.stats.errors++;
            logger.error('Error in scan cycle', { error: (error as Error).message });
        }

        this.stats.cyclesCompleted++;
        this.stats.lastCycleTime = cycleStart;

        const cycleDuration = Date.now() - cycleStart.getTime();
        logger.info(`Cycle completed in ${(cycleDuration / 1000).toFixed(1)}s`);
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

        return {
            market: market,
            forecastProbability: signal.side === 'yes' 
                ? market.yesPrice + signal.estimatedEdge 
                : 1 - (market.noPrice + signal.estimatedEdge), // Approx
            marketProbability: signal.side === 'yes' ? market.yesPrice : market.noPrice,
            edge: signal.estimatedEdge * (signal.side === 'yes' ? 1 : -1), // Positive edge = Buy YES
            action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
            confidence: signal.confidence,
            reason: `⚡ SPEED ARB: ${signal.reason}`,
            weatherDataSource: 'noaa', // Default assumption for speed arb
            forecastValue: forecast?.forecastValue,
            forecastValueUnit: market.thresholdUnit || '°F',
            isGuaranteed: signal.isGuaranteed
        };
    }

    /**
     * Start the bot (continuous polling)
     */
    async start(): Promise<void> {
        this.isRunning = true;
        this.forecastMonitor.start(); // Start forecast monitoring
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
                forecastValue: opp.forecastValue ? `${opp.forecastValue}${opp.forecastValueUnit || ''}` : 'N/A',
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
