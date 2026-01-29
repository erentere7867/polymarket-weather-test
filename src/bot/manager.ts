/**
 * Bot Manager
 * Main orchestrator for the weather arbitrage bot
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { OrderExecutor } from './order-executor.js';
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
        this.orderExecutor = new OrderExecutor(this.tradingClient);
        this.dataStore = new DataStore();
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
        this.forecastMonitor.onForecastChanged = (marketId, change) => {
            logger.info(`🚨 INTERRUPT: Significant forecast change detected! Triggering immediate scan.`);
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
            logger.info('Analyzing markets for opportunities...');
            const opportunities = await this.opportunityDetector.analyzeMarkets(actionableMarkets);

            this.stats.opportunitiesFound += opportunities.length;

            if (opportunities.length === 0) {
                logger.info('No trading opportunities found this cycle');
            } else {
                logger.info(`Found ${opportunities.length} trading opportunities`);
                this.logOpportunities(opportunities);
            }

            // Step 3: Execute trades
            if (opportunities.length > 0) {
                logger.info('Executing trades...');
                const results = await this.orderExecutor.executeOpportunities(opportunities);

                const successfulTrades = results.filter(r => r.executed);
                this.stats.tradesExecuted += successfulTrades.length;

                // Mark successful trades as captured to prevent re-buying at higher prices
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

                logger.info(`Executed ${successfulTrades.length}/${opportunities.length} trades`);
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
