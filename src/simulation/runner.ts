/**
 * Simulation Runner
 * Runs the bot in full simulation mode with a virtual portfolio
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { GammaClient } from '../polymarket/gamma-client.js';
import { OpportunityDetector } from '../bot/opportunity-detector.js';
import { PortfolioSimulator } from './portfolio.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';

interface SimulationConfig {
    startingCapital: number;
    maxPositionSize: number;
    minEdgeThreshold: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    pollIntervalMs: number;
    simulatePriceChanges: boolean;
    priceVolatility: number;
}

export class SimulationRunner {
    private scanner: WeatherScanner;
    private gammaClient: GammaClient;
    private detector: OpportunityDetector;
    private portfolio: PortfolioSimulator;
    private config: SimulationConfig;
    private isRunning: boolean = false;
    private cycleCount: number = 0;
    private startTime: Date;

    constructor(simulationConfig?: Partial<SimulationConfig>) {
        this.config = {
            startingCapital: 1000000,
            maxPositionSize: 50000,
            minEdgeThreshold: config.minEdgeThreshold,
            takeProfitPercent: 0.30,  // 30% profit
            stopLossPercent: 0.20,    // 20% loss
            pollIntervalMs: 30000,    // 30 seconds for simulation
            simulatePriceChanges: true,
            priceVolatility: 0.05,    // 5% max price movement per cycle
            ...simulationConfig,
        };

        this.scanner = new WeatherScanner();
        this.gammaClient = new GammaClient();
        this.detector = new OpportunityDetector();
        this.portfolio = new PortfolioSimulator(this.config.startingCapital);
        this.startTime = new Date();
    }

    /**
     * Run the simulation
     */
    async run(cycles: number = -1): Promise<void> {
        this.isRunning = true;

        console.log('\n' + '═'.repeat(70));
        console.log('       POLYMARKET WEATHER ARBITRAGE BOT - SIMULATION MODE');
        console.log('═'.repeat(70));
        console.log(`\n   Starting Capital:     $${this.config.startingCapital.toLocaleString()}`);
        console.log(`   Max Position Size:    $${this.config.maxPositionSize.toLocaleString()}`);
        console.log(`   Min Edge Threshold:   ${(this.config.minEdgeThreshold * 100).toFixed(0)}%`);
        console.log(`   Take Profit:          ${(this.config.takeProfitPercent * 100).toFixed(0)}%`);
        console.log(`   Stop Loss:            ${(this.config.stopLossPercent * 100).toFixed(0)}%`);
        console.log(`   Poll Interval:        ${this.config.pollIntervalMs / 1000}s`);
        console.log('\n' + '─'.repeat(70));

        while (this.isRunning && (cycles === -1 || this.cycleCount < cycles)) {
            try {
                await this.runCycle();
                this.cycleCount++;

                // Print portfolio summary every 5 cycles
                if (this.cycleCount % 5 === 0) {
                    this.portfolio.printSummary();
                }

                if (this.isRunning && (cycles === -1 || this.cycleCount < cycles)) {
                    await this.delay(this.config.pollIntervalMs);
                }
            } catch (error) {
                logger.error('Simulation cycle failed', { error: (error as Error).message });
                await this.delay(5000);
            }
        }

        // Final summary
        console.log('\n' + '═'.repeat(70));
        console.log('                    SIMULATION COMPLETE');
        console.log('═'.repeat(70));
        this.portfolio.printSummary();
        this.printTradeHistory();
    }

    /**
     * Run a single simulation cycle
     */
    private async runCycle(): Promise<void> {
        const cycleStart = new Date();
        console.log(`\n[Cycle ${this.cycleCount + 1}] ${cycleStart.toLocaleTimeString()} - Scanning markets...`);

        // Step 1: Scan for weather markets
        const allMarkets = await this.scanner.scanForWeatherMarkets();
        const actionableMarkets = this.scanner.filterActionableMarkets(allMarkets);

        console.log(`   Found ${allMarkets.length} weather markets, ${actionableMarkets.length} actionable`);

        // Step 2: Simulate price changes for existing positions
        if (this.config.simulatePriceChanges) {
            this.simulatePriceChanges();
        }

        // Step 3: Auto-close positions (take profit / stop loss)
        const closedPositions = this.portfolio.autoClosePositions(
            this.config.takeProfitPercent,
            -this.config.stopLossPercent
        );
        if (closedPositions.length > 0) {
            console.log(`   Auto-closed ${closedPositions.length} position(s)`);
        }

        // Step 4: Analyze markets for opportunities
        if (actionableMarkets.length > 0) {
            const opportunities = await this.detector.analyzeMarkets(actionableMarkets);
            console.log(`   Found ${opportunities.length} trading opportunities`);

            // Step 5: Open new positions
            for (const opportunity of opportunities) {
                if (Math.abs(opportunity.edge) >= this.config.minEdgeThreshold) {
                    this.portfolio.openPosition(opportunity, this.config.maxPositionSize);
                }
            }
        }

        // Step 6: Simulate more opportunities with fake weather markets if none found
        if (actionableMarkets.length === 0) {
            await this.simulateFakeOpportunities();
        }

        // Print quick stats
        const stats = this.portfolio.getStats();
        const pnlStr = stats.totalPnL >= 0 ? `+$${stats.totalPnL.toFixed(2)}` : `-$${Math.abs(stats.totalPnL).toFixed(2)}`;
        console.log(`   Portfolio: $${stats.totalValue.toLocaleString()} | P&L: ${pnlStr} | Positions: ${stats.openPositions}`);
    }

    /**
     * Simulate price changes for open positions (for testing)
     */
    private simulatePriceChanges(): void {
        for (const position of this.portfolio.getOpenPositions()) {
            // Random walk with slight mean reversion toward forecast probability
            const currentPrice = position.currentPrice;
            const randomChange = (Math.random() - 0.5) * this.config.priceVolatility;

            // Add some drift based on how close we are to target date
            let drift = 0;
            if (position.targetDate) {
                const hoursRemaining = (position.targetDate.getTime() - Date.now()) / (1000 * 60 * 60);
                if (hoursRemaining < 24 && hoursRemaining > 0) {
                    // As we approach expiry, move toward extremes
                    drift = currentPrice > 0.5 ? 0.02 : -0.02;
                }
            }

            const newPrice = Math.max(0.01, Math.min(0.99, currentPrice + randomChange + drift));
            this.portfolio.updatePriceByToken(position.tokenId, newPrice);
        }
    }

    /**
     * Generate fake opportunities when no real ones exist (for simulation)
     */
    private async simulateFakeOpportunities(): Promise<void> {
        // Create some simulated weather markets for testing
        const fakeCities = ['New York City', 'Chicago', 'Los Angeles', 'Miami', 'Seattle'];
        const fakeMetrics = ['temperature_high', 'snowfall', 'precipitation'];

        for (let i = 0; i < 2; i++) {
            const city = fakeCities[Math.floor(Math.random() * fakeCities.length)];
            const metric = fakeMetrics[Math.floor(Math.random() * fakeMetrics.length)];
            const yesPrice = 0.3 + Math.random() * 0.4; // Between 0.3 and 0.7
            const forecastProb = Math.random();
            const edge = forecastProb - yesPrice;

            if (Math.abs(edge) < this.config.minEdgeThreshold) {
                continue; // Skip if no edge
            }

            const fakeMarket: ParsedWeatherMarket = {
                market: {
                    id: `sim_${Date.now()}_${i}`,
                    conditionId: 'sim',
                    slug: 'sim-market',
                    question: `[SIMULATED] Will ${city} ${metric === 'temperature_high' ? 'high temperature exceed 50°F' : metric === 'snowfall' ? 'get snow' : 'have rain'}?`,
                    outcomes: ['Yes', 'No'],
                    outcomePrices: [yesPrice.toString(), (1 - yesPrice).toString()],
                    clobTokenIds: [`sim_yes_${Date.now()}`, `sim_no_${Date.now()}`],
                    active: true,
                    closed: false,
                },
                eventTitle: `[SIMULATED] ${city} Weather`,
                city,
                metricType: metric as any,
                threshold: 50,
                thresholdUnit: 'F',
                comparisonType: 'above',
                targetDate: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
                yesPrice,
                noPrice: 1 - yesPrice,
                yesTokenId: `sim_yes_${Date.now()}_${i}`,
                noTokenId: `sim_no_${Date.now()}_${i}`,
            };

            const fakeOpportunity: TradingOpportunity = {
                market: fakeMarket,
                forecastProbability: forecastProb,
                marketProbability: yesPrice,
                edge,
                action: edge > 0 ? 'buy_yes' : 'buy_no',
                confidence: 0.6 + Math.random() * 0.3,
                reason: `[SIMULATED] Forecast ${(forecastProb * 100).toFixed(0)}% vs Market ${(yesPrice * 100).toFixed(0)}%`,
                weatherDataSource: 'noaa',
                forecastValue: 55 + Math.random() * 20,
                forecastValueUnit: '°F',
            };

            // Open the position
            this.portfolio.openPosition(fakeOpportunity, this.config.maxPositionSize);
        }
    }

    /**
     * Stop the simulation
     */
    stop(): void {
        this.isRunning = false;
    }

    /**
     * Get portfolio simulator
     */
    getPortfolio(): PortfolioSimulator {
        return this.portfolio;
    }

    /**
     * Print trade history
     */
    private printTradeHistory(): void {
        const trades = this.portfolio.getTradeHistory();
        if (trades.length === 0) return;

        console.log('\n📜 TRADE HISTORY (Last 20)');
        console.log('─'.repeat(70));

        const recentTrades = trades.slice(-20);
        for (const trade of recentTrades) {
            const emoji = trade.action === 'buy' ? '🟢' : '🔴';
            const pnlStr = trade.pnl !== undefined
                ? (trade.pnl >= 0 ? ` +$${trade.pnl.toFixed(2)}` : ` -$${Math.abs(trade.pnl).toFixed(2)}`)
                : '';
            console.log(`${emoji} ${trade.timestamp.toLocaleTimeString()} | ${trade.action.toUpperCase()} ${trade.shares} ${trade.side.toUpperCase()} @ $${trade.price.toFixed(3)}${pnlStr}`);
            console.log(`   ${trade.marketQuestion.substring(0, 60)}`);
        }
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
