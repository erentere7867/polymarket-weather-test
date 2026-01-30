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
import { ExitOptimizer } from '../strategy/exit-optimizer.js';
import { MarketModel } from '../probability/market-model.js';

export class SimulationRunner {
    private store: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    private strategy: SpeedArbitrageStrategy;
    private simulator: PortfolioSimulator;
    private scanner: WeatherScanner;
    private exitOptimizer: ExitOptimizer;
    private marketModel: MarketModel;

    private isRunning: boolean = false;
    private cycles: number = 0;
    private maxCycles: number;
    private lastLogTime: number = 0;

    constructor(startingCapital: number = 1000000, maxCycles: number = 20) {
        // Initialize v2 Engine
        this.store = new DataStore();
        this.priceTracker = new PriceTracker(this.store);
        this.forecastMonitor = new ForecastMonitor(this.store);
        this.strategy = new SpeedArbitrageStrategy(this.store);
        this.marketModel = new MarketModel(this.store);
        this.exitOptimizer = new ExitOptimizer(this.marketModel);

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

        // Register markets
        for (const market of markets) {
            this.store.addMarket(market);
        }

        // 2. Connect to Real-Time Data
        await this.priceTracker.start(this.scanner, 60000); // 60s scan for new markets
        this.forecastMonitor.start();

        // Wait a bit for initial data to populate
        logger.info('Waiting 5s for initial data...');
        await new Promise(r => setTimeout(r, 5000));

        // 5. Main Loop
        // We run the loop faster (e.g. 5s) to simulate "Real-Time" without spamming logs
        const loopInterval = 500;

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
        const signals = this.strategy.detectOpportunities();
        if (signals.length > 0) {
            logger.info(`🔎 Found ${signals.length} opportunities`);
        }

        // 3. Execute Trades (Simulated)
        for (const signal of signals) {

            const state = this.store.getMarketState(signal.marketId);
            if (!state) continue;

            const size = signal.size;

            if (size < 10) continue; // Too small

            // Check if we already have a position
            // Ideally the strategy handles this, but for now strict check
            const existingPos = this.simulator.getAllPositions().find(p => p.marketId === signal.marketId && p.side === signal.side);
            if (existingPos) continue;

            // Execute
            const position = this.simulator.openPosition({
                market: state.market,
                forecastProbability: 0,
                marketProbability: 0,
                edge: signal.estimatedEdge,
                action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
                confidence: signal.confidence,
                reason: signal.reason,
                weatherDataSource: 'noaa',
                isGuaranteed: signal.isGuaranteed || false
            }, size);

            // Mark this opportunity as captured to prevent re-buying at higher prices
            if (position && state.lastForecast) {
                this.strategy.markOpportunityCaptured(signal.marketId, state.lastForecast.forecastValue);
            }
        }

        // 4. Check Take Profit / Stop Loss (Smart Exit)
        const openPositions = this.simulator.getOpenPositions();
        for (const pos of openPositions) {
            const state = this.store.getMarketState(pos.marketId);
            const forecastProb = state?.lastForecast?.probability || 0.5;

            const pnlPercent = (pos.currentPrice - pos.entryPrice) / pos.entryPrice;

            const exitSignal = this.exitOptimizer.checkExit({
                marketId: pos.marketId,
                side: pos.side,
                entryPrice: pos.entryPrice,
                currentPrice: pos.currentPrice,
                size: pos.shares,
                entryTime: pos.entryTime,
                pnl: pos.unrealizedPnL,
                pnlPercent
            }, forecastProb);

            if (exitSignal.shouldExit) {
                this.simulator.closePosition(pos.id, pos.currentPrice, exitSignal.reason);
            }
        }

        // 5. Log Forecast Status every 10 minutes
        const now = Date.now();
        if (now - this.lastLogTime >= 600000) { // 10 minutes
            // this.logForecastStatus();
            this.lastLogTime = now;
        }

        /*
        // 5. Print Stats every 5 cycles
        if (this.cycles % 5 === 0) {
            this.simulator.printSummary();
        }
        */
    }

    private logForecastStatus(): void {
        const markets = this.store.getAllMarkets();
        logger.info('--- ☁️ 10-Minute Forecast Update ☁️ ---');
        
        // Group by city for cleaner output
        const cityGroups = new Map<string, Array<{metric: string, value: number, changed: Date, date: string, threshold?: number}>>();

        for (const market of markets) {
            const state = this.store.getMarketState(market.market.id);
            if (!state?.lastForecast) continue;

            const city = market.city;
            if (!city) continue;

            if (!cityGroups.has(city)) {
                cityGroups.set(city, []);
            }

            const dateStr = market.targetDate ? new Date(market.targetDate).toLocaleDateString() : 'No Date';

            cityGroups.get(city)?.push({
                metric: market.metricType,
                value: state.lastForecast.forecastValue,
                changed: state.lastForecast.changeTimestamp,
                date: dateStr,
                threshold: market.threshold
            });
        }

        for (const [city, items] of cityGroups) {
            logger.info(`📍 ${city}:`);
            for (const item of items) {
                logger.info(`   - ${item.date} | ${item.metric}: ${item.value.toFixed(1)} (Threshold: ${item.threshold ?? 'N/A'}) (Last Change: ${item.changed.toLocaleTimeString()})`);
            }
        }
        logger.info('----------------------------------------');
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

    // API Accessors
    getSimulator(): PortfolioSimulator {
        return this.simulator;
    }

    getStore(): DataStore {
        return this.store;
    }

    getCycles(): number {
        return this.cycles;
    }

    isSimulationRunning(): boolean {
        return this.isRunning;
    }

    updateSettings(settings: { takeProfit: number; stopLoss: number }): void {
        // Convert percentage (e.g. 5) to fraction (0.05) if needed, but assuming input is fraction or %?
        // Let's assume input is raw number from UI (e.g. 5 for 5%) -> div 100
        // OR input is already fraction.
        // Let's standardize: UI sends PERCENTAGE (5, 10). We convert to fraction here.
        // Wait, standard is fraction in optimizer. I'll document input as fraction.

        this.exitOptimizer.updateConfig(settings.takeProfit, settings.stopLoss);
        logger.info('Simulation settings updated');
    }

    getSettings(): { takeProfit: number; stopLoss: number } {
        return this.exitOptimizer.getConfig();
    }

    stop(): void {
        logger.info('Stopping simulation...');
        // this.priceTracker.disconnect(); // Removed in v2 optimization
        this.forecastMonitor.stop();
        this.simulator.printSummary();
    }
}
