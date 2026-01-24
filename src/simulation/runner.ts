/**
 * Real-Time Simulation Runner v2
 * Orchestrates the full Speed Arbitrage engine with real-time data
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { GammaClient } from '../polymarket/gamma-client.js';
import { PortfolioSimulator } from './portfolio.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

// v2 Engine Components
import { DataStore } from '../realtime/data-store.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';

export class SimulationRunner {
    private store: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    private strategy: SpeedArbitrageStrategy;
    private simulator: PortfolioSimulator;
    private scanner: WeatherScanner;

    private isRunning: boolean = false;
    private cycles: number = 0;
    private maxCycles: number;

    constructor(startingCapital: number = 1000000, maxCycles: number = 20) {
        // Initialize v2 Engine
        this.store = new DataStore();
        this.priceTracker = new PriceTracker(this.store);
        this.forecastMonitor = new ForecastMonitor(this.store);
        this.strategy = new SpeedArbitrageStrategy(this.store);

        // Initialize Simulator
        this.simulator = new PortfolioSimulator(startingCapital);

        // Scanner
        this.scanner = new WeatherScanner();

        this.maxCycles = maxCycles;
    }

    async start(): Promise<void> {
        logger.info('🚀 Starting Speed Arbitrage Simulation v2...');
        this.isRunning = true;

        // 1. Initial Market Scan
        logger.info('Scanning for weather markets...');
        const markets = await this.scanner.scanForWeatherMarkets();
        logger.info(`Found ${markets.length} weather markets`);

        if (markets.length === 0) {
            logger.warn('No active weather markets found. Simulation cannot run effectively.');
            return;
        }

        // 2. Register markets and start tracking
        for (const market of markets) {
            this.store.addMarket(market);
            this.priceTracker.trackMarket(market.market.id);
        }

        // 3. Connect WebSocket
        await this.priceTracker.connect();

        // 4. Start Forecast Monitor (Initial fetch)
        // We force an immediate poll by starting it
        this.forecastMonitor.start();

        // Wait a bit for initial data to populate
        logger.info('Waiting 5s for initial data...');
        await new Promise(r => setTimeout(r, 5000));

        // 5. Main Loop
        // We run the loop faster (e.g. 5s) to simulate "Real-Time" without spamming logs
        const loopInterval = 5000;

        while (this.isRunning && this.cycles < this.maxCycles) {
            this.cycles++;
            await this.runCycle();

            // Wait for next cycle
            await new Promise(r => setTimeout(r, loopInterval));
        }

        this.stop();
    }

    private async runCycle(): Promise<void> {
        const time = new Date().toLocaleTimeString();
        // logger.info(`[Cycle ${this.cycles}] ${time} - Analyzing...`);

        // 1. Update Portfolio Prices
        this.updatePortfolioPrices();

        // 2. Detect Opportunities
        const edges = this.strategy.detectOpportunities();
        if (edges.length > 0) {
            logger.info(`🔎 Found ${edges.length} opportunities`);
        }

        // 3. Execute Trades (Simulated)
        for (const edge of edges) {
            // Map CalculatedEdge to TradingOpportunity format for Simulator
            // This is a bit of a bridge between v2 Edge and v1 Simulator
            // In a full refactor, Simulator would accept CalculatedEdge

            const state = this.store.getMarketState(edge.marketId);
            if (!state) continue;

            // Calculate position size based on Kelly
            const portfolioValue = this.simulator.getAllPositions().reduce((sum, p) => sum + (p.shares * p.currentPrice), this.simulator.getCashBalance());
            const size = Math.min(
                config.maxPositionSize * 1000, // Scale up for simulation (e.g. $10k instead of $10)
                portfolioValue * edge.KellyFraction
            );

            if (size < 10) continue; // Too small

            // Check if we already have a position
            // Ideally the strategy handles this, but for now strict check
            const existingPos = this.simulator.getAllPositions().find(p => p.marketId === edge.marketId && p.side === edge.side);
            if (existingPos) continue;

            // Execute
            this.simulator.openPosition({
                market: state.market,
                forecastProbability: 0, // Not used in v2 sim directly mostly
                marketProbability: 0,
                edge: edge.adjustedEdge,
                action: edge.side === 'yes' ? 'buy_yes' : 'buy_no',
                confidence: edge.confidence,
                reason: edge.reason,
                weatherDataSource: 'noaa' // Placeholder
            }, size);
        }

        // 4. Check Take Profit / Stop Loss
        this.simulator.checkClosures();

        // 5. Print Stats every 5 cycles
        if (this.cycles % 5 === 0) {
            this.simulator.printSummary();
        }
    }

    private updatePortfolioPrices(): void {
        const markets = this.store.getAllMarkets();

        // Create a map of current prices for the simulator
        // Simulator expects "Market objects" with updated prices
        // But simulator.updatePrices() is not implemented to take a map in v1.
        // Let's look at how simulator updates prices.
        // It has `updatePrices(scannedMarkets: ParsedWeatherMarket[])`

        // We need to create "Updated Markets" with current prices from DataStore
        const updatedMarkets: ParsedWeatherMarket[] = markets.map(m => {
            const state = this.store.getMarketState(m.market.id);
            if (!state) return m;

            // Get latest prices from history
            const lastYes = state.priceHistory.yes.history[state.priceHistory.yes.history.length - 1];
            const lastNo = state.priceHistory.no.history[state.priceHistory.no.history.length - 1];

            return {
                ...m,
                yesPrice: lastYes ? lastYes.price : m.yesPrice,
                noPrice: lastNo ? lastNo.price : m.noPrice
            };
        });

        this.simulator.updatePrices(updatedMarkets);
    }

    stop(): void {
        logger.info('Stopping simulation...');
        this.isRunning = false;
        this.priceTracker.disconnect();
        this.forecastMonitor.stop();
        this.simulator.printSummary();
    }
}
