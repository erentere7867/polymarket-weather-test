/**
 * Bot Manager
 * Main orchestrator for the weather arbitrage bot
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { TradingClient } from '../polymarket/clob-client.js';
import { OpportunityDetector } from './opportunity-detector.js';
import { OrderExecutor } from './order-executor.js';
import { telemetry } from './telemetry.js';
import { config, validateConfig } from '../config.js';
import { logger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';
import { DataStore } from '../realtime/data-store.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';

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

    // Real-time components
    private dataStore: DataStore;
    private forecastMonitor: ForecastMonitor;
    private priceTracker: PriceTracker;
    private speedArbitrageStrategy: SpeedArbitrageStrategy;
    private speedLoopInterval: NodeJS.Timeout | null = null;

    private isRunning: boolean = false;
    private stats: BotStats;

    constructor() {
        this.weatherScanner = new WeatherScanner();
        this.tradingClient = new TradingClient();
        this.opportunityDetector = new OpportunityDetector();
        this.tradingClient = new TradingClient();
        this.opportunityDetector = new OpportunityDetector();
        this.orderExecutor = new OrderExecutor(this.tradingClient);

        // Initialize real-time components
        this.dataStore = new DataStore();
        this.speedArbitrageStrategy = new SpeedArbitrageStrategy(this.dataStore);
        this.forecastMonitor = new ForecastMonitor(this.dataStore);
        this.priceTracker = new PriceTracker(this.dataStore);

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

        logger.info('Bot initialized successfully');
    }

    /**
     * Run a single scan cycle
     */
    async runCycle(): Promise<void> {
        const cycleStart = new Date();
        logger.info('Starting scan cycle...');

        try {
            // Step 1: Scan for weather markets
            // logger.debug('Scanning for weather markets...');

            // OPTIMIZATION: Use DataStore (updated via WebSocket) instead of API polling
            // This prevents memory bloat and rate limits
            let allMarkets = this.dataStore.getAllMarkets();

            if (allMarkets.length === 0) {
                // Initial bootstrap only
                logger.info('Bootstrap: Initial API scan for weather markets...');
                allMarkets = await this.weatherScanner.scanForWeatherMarkets();
                for (const market of allMarkets) {
                    this.dataStore.addMarket(market);
                }
            }

            const actionableMarkets = this.weatherScanner.filterActionableMarkets(allMarkets);

            this.stats.marketsScanned += allMarkets.length;

            // Register markets loop is redundant if we read from DataStore, but safe to keep for new markets
            // for (const market of actionableMarkets) { ... } -- removed

            logger.debug(`Found ${allMarkets.length} weather markets, ${actionableMarkets.length} actionable`);

            if (actionableMarkets.length === 0) {
                logger.debug('No actionable markets found this cycle');
                return;
            }

            // Step 2: Analyze markets for opportunities
            logger.debug('Analyzing markets for opportunities...');
            const opportunities = await this.opportunityDetector.analyzeMarkets(actionableMarkets);

            this.stats.opportunitiesFound += opportunities.length;

            if (opportunities.length === 0) {
                logger.debug('No trading opportunities found this cycle');
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

                        // Record telemetry
                        telemetry.recordTrade({
                            marketId: opp.market.market.id,
                            forecastTimestamp: new Date(), // Would be better if we tracked this
                            tradeTimestamp: new Date(),
                            latencyMs: 0, // To be improved with actual forecast timestamp tracking
                            forecastValue: opp.forecastValue,
                            threshold: opp.market.threshold || 0,
                            sigma: opp.certaintySigma || 0,
                            entryPrice: opp.action === 'buy_yes' ? opp.market.yesPrice : opp.market.noPrice,
                            edge: opp.edge,
                            isGuaranteed: opp.isGuaranteed || false,
                            outcome: 'pending',
                        });
                    }
                }

                logger.info(`Executed ${successfulTrades.length}/${opportunities.length} trades`);

                // Print telemetry summary every 10 trades
                if (this.stats.tradesExecuted > 0 && this.stats.tradesExecuted % 10 === 0) {
                    telemetry.printSummary();
                }
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
        logger.info('Bot started - entering polling loop');
        logger.info(`Poll interval: ${config.pollIntervalMs / 1000}s`);

        // Start real-time monitors
        this.forecastMonitor.start();
        // Price tracker needs scanner to know what to poll
        this.priceTracker.start(this.weatherScanner);

        // Start high-frequency speed arbitrage loop
        this.startSpeedLoop();

        while (this.isRunning) {
            await this.runCycle();

            if (this.isRunning) {
                logger.debug(`Next cycle in ${config.pollIntervalMs / 1000}s...`);
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

        this.forecastMonitor.stop();
        if (this.speedLoopInterval) {
            clearInterval(this.speedLoopInterval);
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
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get telemetry statistics for dashboard
     */
    getTelemetryStats() {
        return telemetry.getStats();
    }

    /**
     * Get trade history from telemetry
     */
    getTradeHistory() {
        return telemetry.getTradeHistory();
    }

    /**
     * Print telemetry summary
     */
    printTelemetrySummary(): void {
        telemetry.printSummary();
    }

    /**
     * High-frequency loop for Speed Arbitrage
     */
    private startSpeedLoop(): void {
        logger.info('Starting Speed Arbitrage Loop (1s interval)...');

        this.speedLoopInterval = setInterval(async () => {
            if (!this.isRunning) return;

            try {
                // 1. Detect Opportunities
                const signals = this.speedArbitrageStrategy.detectOpportunities();

                if (signals.length === 0) return;

                // 2. Map to TradingOpportunity
                const opportunities: TradingOpportunity[] = signals.map(signal => {
                    const state = this.dataStore.getMarketState(signal.marketId);
                    if (!state) return null;

                    const market = state.market;
                    // Mock probabilities for mapping since signal uses calculated edge
                    // We assume signal.confidence ~ forecastProb for mapping visualization
                    // But critical part is EDGE and ACTION

                    return {
                        market,
                        forecastProbability: 0, // Placeholder
                        marketProbability: 0, // Placeholder
                        edge: signal.estimatedEdge,
                        action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
                        confidence: signal.confidence,
                        reason: `🚀 SPEED: ${signal.reason}`,
                        weatherDataSource: 'noaa', // Default
                        isGuaranteed: signal.isGuaranteed,
                        certaintySigma: 0
                    } as TradingOpportunity;
                }).filter((op): op is TradingOpportunity => op !== null);

                if (opportunities.length > 0) {
                    logger.info(`⚡ Speed Arbitrage found ${opportunities.length} signals! Executing immediately.`);

                    // 3. Execute
                    const results = await this.orderExecutor.executeOpportunities(opportunities);

                    // 4. Mark captured
                    for (const result of results) {
                        if (result.executed) {
                            const state = this.dataStore.getMarketState(result.opportunity.market.market.id);
                            if (state && state.lastForecast) {
                                this.speedArbitrageStrategy.markOpportunityCaptured(
                                    result.opportunity.market.market.id,
                                    state.lastForecast.forecastValue
                                );
                            }
                        }
                    }
                }

            } catch (error) {
                logger.error('Error in Speed Loop', { error: (error as Error).message });
            }
        }, 1000); // Check every 1 second
    }
}
