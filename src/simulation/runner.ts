/**
 * Real-Time Simulation Runner v4
 * Orchestrates the Confidence Compression trading engine with real-time data
 * 
 * v4 Changes:
 * - Replaced Speed Arbitrage with Confidence Compression Strategy
 * - Trades on run-to-run stability, NOT latency
 * - Implements model hierarchy (HRRR/ECMWF primary)
 * - Never trades on first run
 * 
 * Features:
 * - Realistic market impact simulation
 * - Cross-market correlation simulation
 * - Performance metrics by strategy component
 * - Parameter optimization framework
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { GammaClient } from '../polymarket/gamma-client.js';
import { PortfolioSimulator } from './portfolio.js';
import { logger } from '../logger.js';
import { config, getEnvVarNumber } from '../config.js';

// v3 Engine Components
import { DataStore } from '../realtime/data-store.js';
import { EventBus, eventBus } from '../realtime/event-bus.js';
import { PriceTracker } from '../realtime/price-tracker.js';
import { ForecastMonitor } from '../realtime/forecast-monitor.js';
import { ConfidenceCompressionStrategy } from '../strategy/confidence-compression-strategy.js';
import { ExitOptimizer } from '../strategy/exit-optimizer.js';
import { EntryOptimizer } from '../strategy/entry-optimizer.js';
import { MarketModel } from '../probability/market-model.js';
import { MarketImpactModel, LiquidityProfile } from '../strategy/market-impact.js';
import { CrossMarketArbitrage } from '../strategy/cross-market-arbitrage.js';
import { SpeedArbitrageStrategy } from '../strategy/speed-arbitrage.js';
import { normalCDF } from '../probability/normal-cdf.js';

/**
 * Performance metrics by strategy component
 */
interface ComponentPerformance {
    confidenceCompression: {
        signalsGenerated: number;
        tradesExecuted: number;
        totalPnl: number;
        avgExecutionTimeMs: number;
        firstRunBlocks: number;
        stabilityBlocks: number;
        confidenceBlocks: number;
    };
    crossMarketArbitrage: {
        opportunitiesDetected: number;
        tradesExecuted: number;
        totalPnl: number;
        correlationAccuracy: number;
    };
    entryOptimizer: {
        optimizationsPerformed: number;
        avgSlippageEstimate: number;
        avgActualSlippage: number;
        positionScalingEvents: number;
    };
    exitOptimizer: {
        exitsTriggered: number;
        trailingStopHits: number;
        takeProfitHits: number;
        stopLossHits: number;
        totalPnl: number;
    };
    marketImpactModel: {
        estimatesMade: number;
        avgEstimatedImpact: number;
        avgActualImpact: number;
        accuracyScore: number;
    };
}

/**
 * Parameter optimization framework
 */
interface OptimizationParameter {
    name: string;
    currentValue: number;
    minValue: number;
    maxValue: number;
    stepSize: number;
    testResults: Array<{
        value: number;
        pnl: number;
        sharpeRatio: number;
        maxDrawdown: number;
    }>;
}

/**
 * Market impact simulation parameters
 */
interface MarketImpactSimulation {
    baseImpactRate: number;      // Base impact per unit of volume
    impactDecayMs: number;       // How quickly impact decays
    volatilityFactor: number;    // How much volatility affects impact
    liquidityFactor: number;     // How liquidity affects impact
}

/**
 * Cross-market correlation simulation
 */
interface CorrelationSimulation {
    correlationStrength: number;     // 0-1 correlation between markets
    lagMs: number;                   // Lag between correlated markets
    noiseLevel: number;              // Random noise in correlation
}

export class SimulationRunner {
    private store: DataStore;
    private priceTracker: PriceTracker;
    private forecastMonitor: ForecastMonitor;
    private strategy: ConfidenceCompressionStrategy;
    private simulator: PortfolioSimulator;
    private scanner: WeatherScanner;
    private exitOptimizer: ExitOptimizer;
    private entryOptimizer: EntryOptimizer;
    private marketModel: MarketModel;
    private marketImpactModel: MarketImpactModel;
    private crossMarketArbitrage: CrossMarketArbitrage;

    private isRunning: boolean = false;
    private cycles: number = 0;
    private maxCycles: number;
    private lastLogTime: number = 0;

    // Performance tracking
    private componentPerformance: ComponentPerformance;
    private optimizationParameters: OptimizationParameter[] = [];

    // Market impact simulation
    private marketImpactSim: MarketImpactSimulation;
    private priceImpactHistory: Map<string, Array<{ timestamp: number; impact: number }>> = new Map();

    // Cross-market correlation simulation
    private correlationSim: CorrelationSimulation;
    private correlatedMarketGroups: Map<string, string[]> = new Map();

    // Speed Arbitrage - store state in data/ folder (outside git, in project root)
    // Falls back to /tmp if data/ is not writable
    private static readonly SPEED_ARB_STATE_FILE = (() => {
        const primary = path.join(process.cwd(), 'data', '.speed-arb-state.json');
        const fallback = '/tmp/.polymarket-speed-arb-state.json';
        try {
            // Test if data/ is writable
            const dir = path.dirname(primary);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Test write
            const testFile = path.join(dir, '.write-test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            return primary;
        } catch (e) {
            logger.warn(`[SpeedArb] Cannot use data/ folder, falling back to ${fallback}: ${(e as Error).message}`);
            return fallback;
        }
    })();
    private speedArbEnabled: boolean = true;  // ENABLED by default for better PnL
    private speedArbStrategy: SpeedArbitrageStrategy;
    private speedArbStats = {
        tradesExecuted: 0,
        totalPnl: 0,
        lastTradeTime: null as Date | null,
        opportunitiesDetected: 0,
        opportunitiesSkipped: 0,
    };

    constructor(startingCapital: number = 10000, maxCycles: number = 20) {
        logger.info(`[SimulationRunner] Initializing v3 with startingCapital: $${startingCapital}`);

        // Initialize v3 Engine
        this.store = new DataStore();
        this.priceTracker = new PriceTracker(this.store);
        this.forecastMonitor = new ForecastMonitor(this.store);
        this.strategy = new ConfidenceCompressionStrategy(this.store);
        this.marketModel = new MarketModel(this.store);
        this.exitOptimizer = new ExitOptimizer(this.marketModel);
        this.marketImpactModel = new MarketImpactModel();
        this.entryOptimizer = new EntryOptimizer(config.maxPositionSize);
        this.crossMarketArbitrage = new CrossMarketArbitrage();

        // Initialize Speed Arbitrage Strategy
        this.speedArbStrategy = new SpeedArbitrageStrategy(this.store);

        // Load persisted speed arb state
        this.loadSpeedArbState();

        // Initialize Simulator
        this.simulator = new PortfolioSimulator(startingCapital);
        logger.info(`[SimulationRunner] PortfolioSimulator initialized. Cash: $${this.simulator.getCashBalance()}, Stats:`, this.simulator.getStats());

        // Scanner
        this.scanner = new WeatherScanner();

        this.maxCycles = maxCycles;

        // Initialize performance tracking
        this.componentPerformance = {
            confidenceCompression: {
                signalsGenerated: 0,
                tradesExecuted: 0,
                totalPnl: 0,
                avgExecutionTimeMs: 0,
                firstRunBlocks: 0,
                stabilityBlocks: 0,
                confidenceBlocks: 0,
            },
            crossMarketArbitrage: {
                opportunitiesDetected: 0,
                tradesExecuted: 0,
                totalPnl: 0,
                correlationAccuracy: 0,
            },
            entryOptimizer: {
                optimizationsPerformed: 0,
                avgSlippageEstimate: 0,
                avgActualSlippage: 0,
                positionScalingEvents: 0,
            },
            exitOptimizer: {
                exitsTriggered: 0,
                trailingStopHits: 0,
                takeProfitHits: 0,
                stopLossHits: 0,
                totalPnl: 0,
            },
            marketImpactModel: {
                estimatesMade: 0,
                avgEstimatedImpact: 0,
                avgActualImpact: 0,
                accuracyScore: 0,
            },
        };

        // Initialize market impact simulation
        this.marketImpactSim = {
            baseImpactRate: 0.001,    // 0.1% base impact
            impactDecayMs: 60000,      // 1 minute decay
            volatilityFactor: 0.5,
            liquidityFactor: 0.3,
        };

        // Initialize correlation simulation
        this.correlationSim = {
            correlationStrength: 0.75,
            lagMs: 300000,             // 5 minute lag
            noiseLevel: 0.1,
        };

        // Setup optimization parameters
        this.initializeOptimizationParameters();
    }

    /**
     * Initialize parameter optimization framework
     */
    private initializeOptimizationParameters(): void {
        this.optimizationParameters = [
            {
                name: 'takeProfit',
                currentValue: 0.10,
                minValue: 0.05,
                maxValue: 0.20,
                stepSize: 0.01,
                testResults: [],
            },
            {
                name: 'stopLoss',
                currentValue: -0.15,
                minValue: -0.25,
                maxValue: -0.05,
                stepSize: 0.01,
                testResults: [],
            },
            {
                name: 'minEdgeThreshold',
                currentValue: config.minEdgeThreshold,
                minValue: 0.05,
                maxValue: 0.20,
                stepSize: 0.01,
                testResults: [],
            },
            {
                name: 'maxPositionSize',
                currentValue: config.maxPositionSize,
                minValue: 5,
                maxValue: 100,
                stepSize: 5,
                testResults: [],
            },
        ];
    }

    async start(): Promise<void> {
        logger.info('🚀 Starting Speed Arbitrage Simulation v3...');
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

        // Setup correlated market groups for simulation
        this.setupCorrelatedMarketGroups(markets);

        // 2. Connect to Real-Time Data
        await this.priceTracker.start(this.scanner, 60000); // 60s scan for new markets
        this.forecastMonitor.start();

        // 3. Wire up immediate execution on forecast changes
        this.forecastMonitor.onForecastChanged = (marketId: string, changeAmount: number) => {
            logger.info(`⚡ Immediate execution triggered for ${marketId} (change: ${changeAmount.toFixed(2)})`);
            this.executeImmediateOpportunity(marketId);
        };

        // 4. Listen for FORECAST_CHANGE events to populate run history store
        // This is CRITICAL for confidence compression strategy to work
        eventBus.on('FORECAST_CHANGE', (event) => {
            if (event.type === 'FORECAST_CHANGE') {
                const { cityId, cityName, variable, oldValue, newValue, model, cycleHour, timestamp, source } = event.payload;
                const runDate = new Date(timestamp);

                // Extract temperature and precipitation from the event
                const isTemp = variable === 'TEMPERATURE';
                const isPrecip = variable === 'PRECIPITATION';

                if (isTemp) {
                    // Value is in Celsius from file-based ingestion
                    const tempC = newValue;
                    this.strategy.processModelRun(
                        cityId,
                        model,
                        cycleHour,
                        runDate,
                        tempC,
                        false, // precipFlag
                        0,     // precipAmountMm
                        source
                    );
                    logger.debug(`[Runner] Processed temperature run: ${cityId}/${model} = ${tempC.toFixed(1)}°C (source: ${source})`);
                } else if (isPrecip) {
                    const precipMm = newValue;
                    this.strategy.processModelRun(
                        cityId,
                        model,
                        cycleHour,
                        runDate,
                        0,     // maxTempC (not available)
                        precipMm > 0.1, // precipFlag
                        precipMm,
                        source
                    );
                    logger.debug(`[Runner] Processed precipitation run: ${cityId}/${model} = ${precipMm.toFixed(1)}mm (source: ${source})`);
                }
            }
        });

        // Wait a bit for initial data to populate
        const startupDelayMs = getEnvVarNumber('STARTUP_DELAY_MS', 1000);
        logger.info(`Waiting ${startupDelayMs}ms for initial data...`);
        await new Promise(r => setTimeout(r, startupDelayMs));

        // 5. Main Loop
        // Use 1000ms (1 second) interval for normal operation to reduce CPU usage
        // and make cycles counter more meaningful in dashboard
        const loopInterval = 1000;

        while (this.isRunning && this.cycles < this.maxCycles) {
            this.cycles++;
            await this.runCycle();

            // Wait for next cycle
            await new Promise(r => setTimeout(r, loopInterval));
        }

        this.stop();
    }

    /**
     * Setup correlated market groups for cross-market simulation
     */
    private setupCorrelatedMarketGroups(markets: ParsedWeatherMarket[]): void {
        // Group markets by city proximity (simplified)
        const cityGroups = new Map<string, ParsedWeatherMarket[]>();

        for (const market of markets) {
            if (!market.city) continue;

            const cityKey = market.city.toLowerCase().replace(/\s+/g, '_');
            if (!cityGroups.has(cityKey)) {
                cityGroups.set(cityKey, []);
            }
            cityGroups.get(cityKey)!.push(market);
        }

        // Find correlated cities
        for (const [city, cityMarkets] of cityGroups) {
            const correlatedCities = this.crossMarketArbitrage.getCorrelatedCities(city, 0.6);

            for (const corr of correlatedCities) {
                const correlatedMarkets = cityGroups.get(corr.cityId) || [];

                // Link markets between correlated cities
                for (const market of cityMarkets) {
                    const existing = this.correlatedMarketGroups.get(market.market.id) || [];
                    for (const corrMarket of correlatedMarkets) {
                        if (!existing.includes(corrMarket.market.id)) {
                            existing.push(corrMarket.market.id);
                        }
                    }
                    this.correlatedMarketGroups.set(market.market.id, existing);
                }
            }
        }

        logger.info(`[Simulation] Setup ${this.correlatedMarketGroups.size} correlated market groups`);
    }

    private async runCycle(): Promise<void> {
        const time = new Date().toLocaleTimeString();
        // logger.info(`[Cycle ${this.cycles}] ${time} - Analyzing...`);

        // 1. Update Portfolio Prices with market impact simulation
        this.updatePortfolioPrices();

        // 2. Detect Cross-Market Opportunities
        if (config.ENABLE_CROSS_MARKET_ARBITRAGE) {
            await this.detectCrossMarketOpportunities();
        }

        // 3. Detect Speed Arbitrage Opportunities
        const startTime = Date.now();
        const signals = this.strategy.detectOpportunities();
        const executionTime = Date.now() - startTime;

        if (signals.length > 0) {
            logger.info(`🔎 Found ${signals.length} confidence compression opportunities`);
            this.componentPerformance.confidenceCompression.signalsGenerated += signals.length;

            // Update average execution time
            const current = this.componentPerformance.confidenceCompression;
            current.avgExecutionTimeMs =
                (current.avgExecutionTimeMs * current.tradesExecuted + executionTime) /
                (current.tradesExecuted + 1);
        }

        // 4. Execute Trades (Simulated) with market impact
        for (const signal of signals) {
            await this.executeTradeWithImpact(signal);
        }

        // 5. Check Take Profit / Stop Loss (Smart Exit) with trailing stops
        await this.checkExits();

        // 6. Log Performance Metrics every 10 cycles
        if (this.cycles % 10 === 0) {
            this.logPerformanceMetrics();
        }

        // 5. Log Forecast Status every 10 minutes
        const now = Date.now();
        if (now - this.lastLogTime >= 600000) { // 10 minutes
            // this.logForecastStatus();
            this.lastLogTime = now;
        }
    }

    /**
     * Detect cross-market arbitrage opportunities
     */
    private async detectCrossMarketOpportunities(): Promise<void> {
        const markets = this.store.getAllMarkets();
        const allSignals: Array<{
            marketId: string;
            side: 'yes' | 'no';
            size: number;
            estimatedEdge: number;
            confidence: number;
            reason: string;
            isGuaranteed?: boolean;
        }> = [];

        // Get all current signals
        const signals = this.strategy.detectOpportunities();
        allSignals.push(...signals);

        // Check for correlated opportunities
        for (const signal of signals) {
            const correlatedMarkets = this.correlatedMarketGroups.get(signal.marketId) || [];

            for (const correlatedMarketId of correlatedMarkets) {
                // Simulate lagged price movement
                const state = this.store.getMarketState(correlatedMarketId);
                if (!state) continue;

                // Simulate correlation-based price prediction
                const correlation = this.crossMarketArbitrage.getCorrelation(
                    signal.marketId,
                    correlatedMarketId
                );

                if (correlation && correlation.correlationCoefficient > config.MIN_CROSS_MARKET_CORRELATION) {
                    this.componentPerformance.crossMarketArbitrage.opportunitiesDetected++;

                    logger.debug(`[CrossMarket] Detected opportunity: ${signal.marketId} -> ${correlatedMarketId} ` +
                        `(correlation: ${correlation.correlationCoefficient.toFixed(2)})`);
                }
            }
        }
    }

    /**
     * Execute trade with market impact simulation
     */
    private async executeTradeWithImpact(signal: {
        marketId: string;
        side: 'yes' | 'no';
        size: number;
        estimatedEdge: number;
        confidence: number;
        reason: string;
        isGuaranteed?: boolean;
    }): Promise<void> {
        logger.info(`Processing signal for ${signal.marketId} (Size: ${signal.size})`);

        const state = this.store.getMarketState(signal.marketId);
        if (!state) {
            logger.error(`State missing for ${signal.marketId}`);
            return;
        }

        let size = signal.size;

        // Lower minimum size threshold to match portfolio.ts (was 10, now 5)
        if (size < 5) {
            logger.warn(`Size too small: ${size}`);
            return;
        }

        // Check if we already have a position
        const existingPos = this.simulator.getAllPositions().find(p => p.marketId === signal.marketId && p.side === signal.side);
        if (existingPos) {
            logger.info(`Existing position found for ${signal.marketId}`);
            return;
        }

        // Simulate market impact
        const marketVolume = parseFloat(state.market.market.volume || '50000');
        const liquidity: LiquidityProfile = {
            dailyVolume: marketVolume,
            averageTradeSize: marketVolume / 100,
            bidDepth: state.market.yesPrice * marketVolume * 0.1,
            askDepth: state.market.noPrice * marketVolume * 0.1,
            spread: Math.abs(state.market.yesPrice + state.market.noPrice - 1),
            volatility: Math.abs(this.marketModel.getPriceVelocity(signal.marketId, 'yes')),
        };

        // Get impact estimate
        const impactEstimate = this.marketImpactModel.estimateCompleteImpact(size, liquidity);

        // Track impact model performance
        this.componentPerformance.marketImpactModel.estimatesMade++;
        const currentImpact = this.componentPerformance.marketImpactModel;
        currentImpact.avgEstimatedImpact =
            (currentImpact.avgEstimatedImpact * (currentImpact.estimatesMade - 1) + impactEstimate.totalCost) /
            currentImpact.estimatesMade;

        // Simulate actual impact (with some randomness)
        const actualImpact = this.simulateMarketImpact(size, marketVolume, liquidity);
        currentImpact.avgActualImpact =
            (currentImpact.avgActualImpact * (currentImpact.estimatesMade - 1) + actualImpact) /
            currentImpact.estimatesMade;

        // Update accuracy score
        const estimateError = Math.abs(impactEstimate.totalCost - actualImpact);
        currentImpact.accuracyScore = Math.max(0, 1 - estimateError * 10);

        // Apply impact to execution price
        const priceAdjustment = 1 + actualImpact;

        // Track entry optimizer performance
        this.componentPerformance.entryOptimizer.optimizationsPerformed++;
        this.componentPerformance.entryOptimizer.avgSlippageEstimate =
            (this.componentPerformance.entryOptimizer.avgSlippageEstimate *
                (this.componentPerformance.entryOptimizer.optimizationsPerformed - 1) +
                impactEstimate.slippageEstimate) / this.componentPerformance.entryOptimizer.optimizationsPerformed;

        // Check if position scaling is needed
        if (config.ENABLE_POSITION_SCALING && size > config.POSITION_SCALE_THRESHOLD) {
            this.componentPerformance.entryOptimizer.positionScalingEvents++;
            logger.info(`[PositionScaling] Scaling position for ${signal.marketId}: ${size} -> ${Math.floor(size / 2)}`);
            size = Math.floor(size / 2);
        }

        // Execute
        try {
            const position = this.simulator.openPosition({
                market: state.market,
                forecastProbability: 0,
                marketProbability: 0,
                edge: signal.estimatedEdge,
                action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
                confidence: signal.confidence,
                reason: signal.reason,
                weatherDataSource: 'noaa',
                isGuaranteed: signal.isGuaranteed || false,
                snapshotYesPrice: state.market.yesPrice * priceAdjustment,
                snapshotNoPrice: state.market.noPrice * priceAdjustment,
                snapshotTimestamp: new Date(),
            }, size);

            if (!position) {
                logger.warn(`openPosition returned null for ${signal.marketId}`);
            } else {
                logger.info(`Trade executed successfully: ${position.id} (Impact: ${(actualImpact * 100).toFixed(2)}%)`);
                this.componentPerformance.confidenceCompression.tradesExecuted++;
            }

            // Mark this opportunity as captured to prevent re-buying at higher prices
            if (position && state.lastForecast) {
                this.strategy.markOpportunityCaptured(signal.marketId, state.lastForecast.forecastValue);
            }
        } catch (e) {
            logger.error(`Exception in openPosition: ${(e as Error).message}`);
        }
    }

    /**
     * Simulate realistic market impact
     */
    private simulateMarketImpact(orderSize: number, dailyVolume: number, liquidity: LiquidityProfile): number {
        // Base impact from square-root law
        const participationRate = orderSize / dailyVolume;
        const baseImpact = this.marketImpactSim.baseImpactRate * Math.sqrt(participationRate);

        // Adjust for liquidity
        const liquidityScore = Math.min(1, dailyVolume / 100000);
        const liquidityAdjustment = 1 / (liquidityScore + 0.1);

        // Adjust for volatility
        const volatilityAdjustment = 1 + (liquidity.volatility * this.marketImpactSim.volatilityFactor);

        // Add random noise
        const noise = (Math.random() - 0.5) * 2 * this.correlationSim.noiseLevel;

        const totalImpact = baseImpact * liquidityAdjustment * volatilityAdjustment * (1 + noise);

        // Store impact for decay calculation
        if (!this.priceImpactHistory.has(liquidity.toString())) {
            this.priceImpactHistory.set(liquidity.toString(), []);
        }
        this.priceImpactHistory.get(liquidity.toString())!.push({
            timestamp: Date.now(),
            impact: totalImpact,
        });

        return Math.min(totalImpact, 0.10); // Cap at 10%
    }

    /**
     * Check exits with trailing stops
     */
    private async checkExits(): Promise<void> {
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
                // Track exit performance
                this.componentPerformance.exitOptimizer.exitsTriggered++;

                if (exitSignal.reason?.includes('Trailing Stop')) {
                    this.componentPerformance.exitOptimizer.trailingStopHits++;
                } else if (exitSignal.reason?.includes('Take Profit')) {
                    this.componentPerformance.exitOptimizer.takeProfitHits++;
                } else if (exitSignal.reason?.includes('Stop Loss')) {
                    this.componentPerformance.exitOptimizer.stopLossHits++;
                }

                this.componentPerformance.exitOptimizer.totalPnl += pos.unrealizedPnL;

                this.simulator.closePosition(pos.id, pos.currentPrice, exitSignal.reason || 'Unknown');
            }
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

            // Apply decayed impact from previous trades
            const decayedImpact = this.calculateDecayedImpact(m.market.id);

            return {
                ...m,
                yesPrice: Math.max(0.01, Math.min(0.99, (lastYes ? lastYes.price : m.yesPrice) + decayedImpact)),
                noPrice: Math.max(0.01, Math.min(0.99, (lastNo ? lastNo.price : m.noPrice) - decayedImpact)),
            };
        });

        this.simulator.updatePrices(updatedMarkets);
    }

    /**
     * Calculate decayed impact from previous trades
     */
    private calculateDecayedImpact(marketId: string): number {
        const history = this.priceImpactHistory.get(marketId) || [];
        const now = Date.now();
        let totalImpact = 0;

        // Clean old entries and calculate decayed impact
        const validHistory = history.filter(h => {
            const age = now - h.timestamp;
            if (age > this.marketImpactSim.impactDecayMs * 5) return false;

            // Calculate decay
            const decayFactor = Math.exp(-age / this.marketImpactSim.impactDecayMs);
            totalImpact += h.impact * decayFactor;
            return true;
        });

        this.priceImpactHistory.set(marketId, validHistory);
        return totalImpact;
    }

    /**
     * Log performance metrics
     */
    private logPerformanceMetrics(): void {
        const perf = this.componentPerformance;

        logger.info('📊 Component Performance Metrics:');
        logger.info(`  Confidence Compression: ${perf.confidenceCompression.signalsGenerated} signals, ${perf.confidenceCompression.tradesExecuted} trades, ` +
            `${perf.confidenceCompression.avgExecutionTimeMs.toFixed(1)}ms avg execution`);
        logger.info(`  Cross-Market: ${perf.crossMarketArbitrage.opportunitiesDetected} opportunities detected`);
        logger.info(`  Entry Optimizer: ${perf.entryOptimizer.optimizationsPerformed} optimizations, ` +
            `${perf.entryOptimizer.positionScalingEvents} scaling events`);
        logger.info(`  Exit Optimizer: ${perf.exitOptimizer.exitsTriggered} exits ` +
            `(${perf.exitOptimizer.trailingStopHits} trailing, ${perf.exitOptimizer.takeProfitHits} TP, ${perf.exitOptimizer.stopLossHits} SL)`);
        logger.info(`  Market Impact Model: ${perf.marketImpactModel.estimatesMade} estimates, ` +
            `${(perf.marketImpactModel.accuracyScore * 100).toFixed(1)}% accuracy ` +
            `(est: ${(perf.marketImpactModel.avgEstimatedImpact * 100).toFixed(2)}%, ` +
            `actual: ${(perf.marketImpactModel.avgActualImpact * 100).toFixed(2)}%)`);
    }

    /**
     * Run parameter optimization
     */
    async runParameterOptimization(): Promise<void> {
        logger.info('🔬 Starting parameter optimization...');

        const startingCapital = this.simulator.getCashBalance();

        for (const param of this.optimizationParameters) {
            logger.info(`  Testing parameter: ${param.name}`);

            for (let value = param.minValue; value <= param.maxValue; value += param.stepSize) {
                // Reset simulator
                this.simulator = new PortfolioSimulator(startingCapital);

                // Apply parameter
                if (param.name === 'takeProfit' || param.name === 'stopLoss') {
                    this.exitOptimizer.updateConfig(
                        param.name === 'takeProfit' ? value : 0.10,
                        param.name === 'stopLoss' ? value : -0.15
                    );
                }

                // Run simulation (simplified - just a few cycles)
                const cyclesToRun = 10;
                for (let i = 0; i < cyclesToRun && this.isRunning; i++) {
                    await this.runCycle();
                }

                // Record results
                const stats = this.simulator.getStats();
                param.testResults.push({
                    value,
                    pnl: stats.totalPnL,
                    sharpeRatio: this.calculateSharpeRatio(),
                    maxDrawdown: this.calculateMaxDrawdown(),
                });

                logger.info(`    Value ${value.toFixed(2)}: PnL $${stats.totalPnL.toFixed(2)}`);
            }

            // Find optimal value
            const bestResult = param.testResults.reduce((best, current) =>
                current.pnl > best.pnl ? current : best
            );

            logger.info(`  Optimal ${param.name}: ${bestResult.value.toFixed(2)} (PnL: $${bestResult.pnl.toFixed(2)})`);
        }
    }

    /**
     * Calculate Sharpe ratio from closed trade PnLs
     */
    private calculateSharpeRatio(): number {
        const stats = this.simulator.getStats();
        const closedTrades = stats.closedPositions || 0;
        if (closedTrades < 2) return 0;

        // Approximate: mean return per trade / rough stddev estimate
        const meanReturn = stats.totalPnL / closedTrades;
        // Without per-trade history, estimate stddev as fraction of mean
        // A proper implementation would track individual trade returns
        const estimatedStdDev = Math.abs(meanReturn) * 0.5 + 0.01;
        return meanReturn / estimatedStdDev;
    }

    /**
     * Calculate max drawdown from portfolio stats
     */
    private calculateMaxDrawdown(): number {
        const stats = this.simulator.getStats();
        // Use the simulator's tracked max drawdown if available, else estimate from PnL
        if ('maxDrawdown' in stats && typeof (stats as any).maxDrawdown === 'number') {
            return (stats as any).maxDrawdown;
        }
        // Fallback: estimate from worst loss relative to starting capital
        const startingCapital = this.simulator.getCashBalance() - stats.totalPnL;
        return startingCapital > 0 ? Math.max(0, -stats.totalPnL / startingCapital) : 0;
    }

    private logForecastStatus(): void {
        const markets = this.store.getAllMarkets();
        logger.info('--- ☁️ 10-Minute Forecast Update ☁️ ---');

        // Group by city for cleaner output
        const cityGroups = new Map<string, Array<{ metric: string, value: number, changed: Date, date: string, threshold?: number }>>();

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

    // API Accessors
    getSimulator(): PortfolioSimulator {
        return this.simulator;
    }

    getStore(): DataStore {
        return this.store;
    }

    getStrategy(): ConfidenceCompressionStrategy {
        return this.strategy;
    }

    getCycles(): number {
        return this.cycles;
    }

    isSimulationRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get market analysis for dashboard
     */
    getMarketAnalysis(): any[] {
        return this.strategy.getAllMarketAnalysis();
    }

    /**
     * Get component performance metrics
     */
    getComponentPerformance(): ComponentPerformance {
        return { ...this.componentPerformance };
    }

    /**
     * Get optimization parameters with results
     */
    getOptimizationParameters(): OptimizationParameter[] {
        return this.optimizationParameters.map(p => ({ ...p }));
    }

    updateSettings(settings: { takeProfit: number; stopLoss: number; skipPriceCheck?: boolean; speedArbEnabled?: boolean }): void {
        this.exitOptimizer.updateConfig(settings.takeProfit, settings.stopLoss);

        if (typeof settings.speedArbEnabled === 'boolean') {
            this.setSpeedArbEnabled(settings.speedArbEnabled);
        }

        logger.info('Simulation settings updated');
    }

    getSettings(): { takeProfit: number; stopLoss: number; skipPriceCheck: boolean; speedArbEnabled: boolean } {
        return {
            ...this.exitOptimizer.getConfig(),
            skipPriceCheck: this.speedArbEnabled,
            speedArbEnabled: this.speedArbEnabled,
        };
    }

    /**
     * Enable/disable speed arbitrage mode (persisted to disk)
     */
    setSpeedArbEnabled(enabled: boolean): void {
        this.speedArbEnabled = enabled;
        this.saveSpeedArbState();
        logger.info(`⚡ Speed Arbitrage mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    private saveSpeedArbState(): void {
        try {
            const dir = path.dirname(SimulationRunner.SPEED_ARB_STATE_FILE);
            if (!fs.existsSync(dir)) {
                logger.info(`[SpeedArb] Creating state directory: ${dir}`);
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(SimulationRunner.SPEED_ARB_STATE_FILE, JSON.stringify({ enabled: this.speedArbEnabled }));
            logger.info(`[SpeedArb] State saved: enabled=${this.speedArbEnabled} to ${SimulationRunner.SPEED_ARB_STATE_FILE}`);
        } catch (e) {
            logger.error(`[SpeedArb] Failed to save state: ${(e as Error).message}`);
        }
    }

    private loadSpeedArbState(): void {
        try {
            logger.info(`[SpeedArb] Looking for state file at: ${SimulationRunner.SPEED_ARB_STATE_FILE}`);
            if (fs.existsSync(SimulationRunner.SPEED_ARB_STATE_FILE)) {
                const content = fs.readFileSync(SimulationRunner.SPEED_ARB_STATE_FILE, 'utf-8');
                logger.info(`[SpeedArb] Raw state file content: ${content}`);
                const data = JSON.parse(content);
                logger.info(`[SpeedArb] Loaded state file: ${JSON.stringify(data)}`);
                if (typeof data.enabled === 'boolean') {
                    this.speedArbEnabled = data.enabled;
                    logger.info(`⚡ Speed Arbitrage state loaded from disk: ${this.speedArbEnabled ? 'ENABLED' : 'DISABLED'}`);
                }
            } else {
                logger.info(`[SpeedArb] No state file found, using default: ENABLED`);
            }
        } catch (e) {
            logger.warn(`[SpeedArb] Could not load speed arb state: ${(e as Error).message}`);
        }
    }

    /**
     * Get speed arbitrage stats for dashboard
     */
    getSpeedArbStats(): { enabled: boolean; trades: number; pnl: number; opportunities: number; skipped: number; lastTradeTime: Date | null } {
        return {
            enabled: this.speedArbEnabled,
            trades: this.speedArbStats.tradesExecuted,
            pnl: this.speedArbStats.totalPnl,
            opportunities: this.speedArbStats.opportunitiesDetected,
            skipped: this.speedArbStats.opportunitiesSkipped,
            lastTradeTime: this.speedArbStats.lastTradeTime,
        };
    }

    stop(): void {
        logger.info('Stopping simulation...');
        this.isRunning = false;
        // this.priceTracker.disconnect(); // Removed in v2 optimization
        this.forecastMonitor.stop();

        // Log final performance metrics
        this.logPerformanceMetrics();

        this.simulator.printSummary();
    }

    /**
     * Execute opportunity immediately when forecast changes (bypass cycle loop)
     * When speedArbEnabled: uses SpeedArbitrageStrategy for instant execution
     * When disabled: falls back to ConfidenceCompression strategy
     */
    private async executeImmediateOpportunity(marketId: string): Promise<void> {
        const executionStart = Date.now();
        const state = this.store.getMarketState(marketId);
        if (!state) return;

        // Update prices first to get latest market data
        this.updatePortfolioPrices();

        // =====================================================
        // SPEED ARBITRAGE FAST PATH
        // =====================================================
        if (this.speedArbEnabled) {
            this.speedArbStats.opportunitiesDetected++;

            const forecast = state.lastForecast;
            if (!forecast) {
                this.speedArbStats.opportunitiesSkipped++;
                return;
            }

            const market = state.market;
            let threshold = market.threshold;
            if (threshold === undefined) return;
            if (market.thresholdUnit === 'C') {
                threshold = (threshold * 9 / 5) + 32;
            }

            // Dynamic uncertainty based on days to event
            let uncertainty: number;
            const daysToEvent = market.targetDate
                ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                : 3;
            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_low':
                case 'temperature_threshold':
                    uncertainty = 1.5 + 0.8 * daysToEvent;
                    break;
                default:
                    uncertainty = 3 + 1.0 * daysToEvent;
            }

            const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

            // NO sigma gate — speed arb bypasses all entry checks

            // Calculate probability using CDF
            const z = (forecast.forecastValue - threshold) / uncertainty;
            let forecastProb: number;
            if (market.comparisonType === 'above') {
                forecastProb = normalCDF(z);
            } else if (market.comparisonType === 'below') {
                forecastProb = 1 - normalCDF(z);
            } else {
                return;
            }

            // Get current market price (stale — that's the opportunity)
            const priceYes = market.yesPrice;
            const priceNo = market.noPrice;

            // Calculate edge directly — no EdgeCalculator overhead
            const edgeYes = forecastProb - priceYes;
            const edgeNo = (1 - forecastProb) - priceNo;

            let side: 'yes' | 'no';
            let edge: number;
            if (edgeYes > edgeNo) {
                side = 'yes';
                edge = edgeYes;
            } else {
                side = 'no';
                edge = edgeNo;
            }

            // NO edge minimum — any positive edge is accepted, stale price IS the edge
            if (edge <= 0) {
                this.speedArbStats.opportunitiesSkipped++;
                return;
            }

            // Only check: do we already hold this position?
            const existingPos = this.simulator.getAllPositions().find(p => p.marketId === marketId && p.side === side);
            if (existingPos) {
                this.speedArbStats.opportunitiesSkipped++;
                return;
            }

            // Full position size for speed arb — max conviction
            const size = config.maxPositionSize;

            try {
                const position = this.simulator.openPosition({
                    market: state.market,
                    forecastProbability: forecastProb,
                    marketProbability: priceYes,
                    edge: edge,
                    action: side === 'yes' ? 'buy_yes' : 'buy_no',
                    confidence: Math.min(1, sigma / 3),
                    reason: `⚡ SPEED ARB: ${sigma.toFixed(1)}σ, edge ${(edge * 100).toFixed(1)}%, forecast ${forecast.forecastValue.toFixed(1)} vs threshold ${threshold}`,
                    weatherDataSource: 'noaa',
                    isGuaranteed: sigma >= 3,
                    snapshotYesPrice: priceYes,
                    snapshotNoPrice: priceNo,
                    snapshotTimestamp: new Date(),
                }, size);

                if (position) {
                    const latencyMs = Date.now() - executionStart;
                    this.speedArbStats.tradesExecuted++;
                    this.speedArbStats.lastTradeTime = new Date();
                    this.speedArbStrategy.markOpportunityCaptured(marketId, forecast.forecastValue);
                    logger.info(`⚡ SPEED ARB EXECUTED in ${latencyMs}ms: ${position.id} | ${side.toUpperCase()} | edge ${(edge * 100).toFixed(1)}% | size $${size} | ${market.market.question.substring(0, 50)}`);
                }
            } catch (e) {
                logger.error(`Exception in speed arb execution: ${(e as Error).message}`);
            }
            return;
        }

        // =====================================================
        // CONFIDENCE COMPRESSION FALLBACK PATH
        // =====================================================
        const allSignals = this.strategy.detectOpportunities();
        const marketSignals = allSignals.filter(s => s.marketId === marketId);

        for (const signal of marketSignals) {
            const existingPos = this.simulator.getAllPositions().find(p => p.marketId === signal.marketId && p.side === signal.side);
            if (existingPos) continue;

            const size = signal.size;
            if (size < 5) continue;

            try {
                const position = this.simulator.openPosition({
                    market: state.market,
                    forecastProbability: 0,
                    marketProbability: 0,
                    edge: signal.estimatedEdge,
                    action: signal.side === 'yes' ? 'buy_yes' : 'buy_no',
                    confidence: signal.confidence,
                    reason: signal.reason + ' (IMMEDIATE)',
                    weatherDataSource: 'noaa',
                    isGuaranteed: signal.isGuaranteed || false,
                    snapshotYesPrice: state.market.yesPrice,
                    snapshotNoPrice: state.market.noPrice,
                    snapshotTimestamp: new Date(),
                }, size);

                if (position && state.lastForecast) {
                    this.strategy.markOpportunityCaptured(signal.marketId, state.lastForecast.forecastValue);
                    logger.info(`⚡ IMMEDIATE trade executed: ${position.id}`);
                }
            } catch (e) {
                logger.error(`Exception in immediate execution: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Update cache TTL for forecast monitoring (dashboard control)
     */
    updateCacheTtl(newTtlMs: number): void {
        this.forecastMonitor.cacheTtlMs = newTtlMs;
        logger.info(`Cache TTL updated to ${newTtlMs}ms`);
    }

    /**
     * Get current cache TTL
     */
    getCacheTtl(): number {
        return this.forecastMonitor.cacheTtlMs;
    }

    /**
     * Update forecast poll interval dynamically (dashboard control)
     */
    updatePollInterval(newIntervalMs: number): void {
        this.forecastMonitor.updatePollInterval(newIntervalMs);
    }

    /**
     * Get current poll interval
     */
    getPollInterval(): number {
        // Access the private pollIntervalMs from forecastMonitor if possible
        // Otherwise return default
        return (this.forecastMonitor as any).pollIntervalMs || config.forecastPollIntervalMs;
    }

    /**
     * Update market impact simulation parameters
     */
    updateMarketImpactSim(params: Partial<MarketImpactSimulation>): void {
        this.marketImpactSim = { ...this.marketImpactSim, ...params };
        logger.info('Market impact simulation parameters updated', this.marketImpactSim);
    }

    /**
     * Update correlation simulation parameters
     */
    updateCorrelationSim(params: Partial<CorrelationSimulation>): void {
        this.correlationSim = { ...this.correlationSim, ...params };
        logger.info('Correlation simulation parameters updated', this.correlationSim);
    }
}

export default SimulationRunner;
