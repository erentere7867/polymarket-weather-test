/**
 * Speed Arbitrage Strategy
 * Fast execution on forecast changes - trades within seconds of new data
 *
 * Redesigned: Now requires threshold crossing for signal generation.
 * Only trades when a forecast change crosses a market's threshold (e.g., 15°F → 17°F for a 16°F threshold).
 *
 * When SPEED_ARBITRAGE_MODE is OFF: Requires HRRR to confirm RAP data for US cities before trading.
 */

import { DataStore } from '../realtime/data-store.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator } from '../probability/edge-calculator.js';
import { EntryOptimizer, EntrySignal } from './entry-optimizer.js';
import { MarketImpactModel } from './market-impact.js';
import { normalCDF } from '../probability/normal-cdf.js';
import { ModelHierarchy } from './model-hierarchy.js';
import { ThresholdPosition } from '../realtime/types.js';
import { config, SPEED_ARBITRAGE_CONFIG } from '../config.js';
import { logger, rateLimitedLogger } from '../logger.js';
import { ConfirmationManager } from '../weather/confirmation-manager.js';
import { KNOWN_CITIES } from '../weather/types.js';

const MAX_CHANGE_AGE_MS = 120000; // 2 minutes
// MIN_SIGMA_FOR_ARBITRAGE is now configurable via config.SPEED_ARB_MIN_SIGMA (default: 0.3)

// Edge decay configuration - USE CONFIG VALUES FROM ENV
const EDGE_DECAY_HALF_LIFE_MS = config.EDGE_DECAY_HALF_LIFE_MS;  // 90s from env
const EDGE_DECAY_MAX_AGE_MS = config.EDGE_DECAY_MAX_AGE_MS;   // 4min from env
const URGENCY_SIZE_MULTIPLIER = 1.5;    // Max size boost for fresh signals

export class SpeedArbitrageStrategy {
    private store: DataStore;
    private marketModel: MarketModel;
    private marketImpactModel: MarketImpactModel;
    private edgeCalculator: EdgeCalculator;
    private entryOptimizer: EntryOptimizer;
    private modelHierarchy: ModelHierarchy;
    private confirmationManager: ConfirmationManager | null = null;

    private capturedOpportunities: Map<string, { forecastValue: number; capturedAt: Date }> = new Map();

    constructor(store: DataStore) {
        this.store = store;
        this.marketModel = new MarketModel(store);
        this.marketImpactModel = new MarketImpactModel();
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(config.maxPositionSize);
        this.modelHierarchy = new ModelHierarchy();
    }
    
    /**
     * Set the confirmation manager for RAP-HRRR cross-model confirmation
     * Must be called before detectOpportunity if SPEED_ARBITRAGE_MODE is OFF
     */
    public setConfirmationManager(manager: ConfirmationManager): void {
        this.confirmationManager = manager;
    }

    /**
     * Mark opportunity as captured
     */
    markOpportunityCaptured(marketId: string, forecastValue: number): void {
        this.capturedOpportunities.set(marketId, { forecastValue, capturedAt: new Date() });
        
        // FIXED: Prune old entries to prevent memory leak
        // Run pruning every time we add a new entry if map is getting large
        if (this.capturedOpportunities.size > 100) {
            this.pruneCapturedOpportunities();
        }
    }

    /**
     * Prune old entries from captured opportunities map
     * FIXED: Prevents memory leak by removing stale entries
     * Removes entries older than 1 hour or if more than 200 entries exist
     */
    private pruneCapturedOpportunities(): void {
        const now = Date.now();
        const maxAgeMs = 60 * 60 * 1000; // 1 hour
        const maxEntries = 200;
        
        // If we're over the limit, prune oldest entries
        if (this.capturedOpportunities.size > maxEntries) {
            // Convert to array, sort by timestamp, keep newest entries
            const entries = Array.from(this.capturedOpportunities.entries())
                .sort((a, b) => b[1].capturedAt.getTime() - a[1].capturedAt.getTime());
            
            // Keep only the most recent entries
            const toKeep = entries.slice(0, maxEntries);
            this.capturedOpportunities.clear();
            for (const [key, value] of toKeep) {
                this.capturedOpportunities.set(key, value);
            }
            logger.debug(`[SpeedArbitrage] Pruned captured opportunities to ${maxEntries} entries`);
            return;
        }
        
        // Otherwise, remove old entries
        let pruned = 0;
        for (const [marketId, data] of this.capturedOpportunities.entries()) {
            if (now - data.capturedAt.getTime() > maxAgeMs) {
                this.capturedOpportunities.delete(marketId);
                pruned++;
            }
        }
        
        if (pruned > 0) {
            logger.debug(`[SpeedArbitrage] Pruned ${pruned} old captured opportunities`);
        }
    }

    /**
     * Check if opportunity is already captured
     */
    private isOpportunityCaptured(marketId: string, currentForecastValue: number): boolean {
        const captured = this.capturedOpportunities.get(marketId);
        if (!captured) return false;

        const forecastDiff = Math.abs(currentForecastValue - captured.forecastValue);
        if (forecastDiff >= 1.0) {
            this.capturedOpportunities.delete(marketId);
            return false;
        }

        return true;
    }

    /**
     * Detect opportunity for a specific market
     */
    detectOpportunity(marketId: string): EntrySignal | null {
        const state = this.store.getMarketState(marketId);
        if (!state?.lastForecast) return null;

        const market = state.market;
        const now = Date.now();
        const forecast = state.lastForecast;

        // DEBUG: Log what's being read for trading
        if (market.city?.toLowerCase().includes('toronto')) {
            const thresholdF = market.threshold !== undefined 
                ? (market.thresholdUnit === 'C' ? (market.threshold * 9/5) + 32 : market.threshold)
                : 0;
            logger.info(`[SPEED ARB DEBUG] ${market.city}: forecastValue=${forecast.forecastValue}°F, previousValue=${forecast.previousValue}°F, valueChanged=${forecast.valueChanged}, threshold=${thresholdF}°F (${market.threshold}${market.thresholdUnit}), changeAge=${now - forecast.changeTimestamp.getTime()}ms`);
            // Calculate what the probability would be
            const sigmaTest = thresholdF > 0 ? Math.abs(forecast.forecastValue - thresholdF) / 3 : 0;
            const probTest = normalCDF(sigmaTest);
            logger.info(`[SPEED ARB DEBUG] Would calculate: sigma=${sigmaTest.toFixed(2)}, prob=${(probTest*100).toFixed(1)}%`);
        }

        // Must be a recent change (not first data)
        if (forecast.previousValue === undefined) {
            logger.debug(`Speed arb: Skipping first data point for ${market.city}`);
            return null;
        }

        const changeAge = now - forecast.changeTimestamp.getTime();
        if (!forecast.valueChanged) {
            logger.debug(`Speed arb: valueChanged=false for ${market.city}, previousValue=${forecast.previousValue}, currentValue=${forecast.forecastValue}, changeAmount=${forecast.changeAmount}`);
            return null;
        }
        if (changeAge > MAX_CHANGE_AGE_MS) {
            logger.debug(`Speed arb: changeAge=${changeAge}ms > MAX_CHANGE_AGE_MS=${MAX_CHANGE_AGE_MS}ms for ${market.city}`);
            return null;
        }

        // ========================================
        // Threshold-Crossing Detection (when enabled)
        // ========================================
        if (config.SPEED_ARB_REQUIRE_THRESHOLD_CROSSING) {
            let threshold = market.threshold;
            if (threshold === undefined) {
                logger.debug(`Speed arb: No threshold defined for ${market.city}`);
                return null;
            }
            if (market.thresholdUnit === 'C') {
                threshold = (threshold * 9 / 5) + 32;
            }

            const prevPosition = this.calculateThresholdPosition(forecast.previousValue, threshold);
            const currPosition = this.calculateThresholdPosition(forecast.forecastValue, threshold);
            const crossing = this.detectThresholdCrossing(prevPosition, currPosition, config.SPEED_ARB_MIN_CROSSING_DISTANCE);
            
            if (!crossing.crossed) {
                logger.debug(`Speed arb: Forecast change did not cross threshold for ${market.city}`, {
                    previousValue: forecast.previousValue,
                    currentValue: forecast.forecastValue,
                    threshold,
                });
                return null;
            }
            logger.debug(`Speed arb: Threshold crossed ${crossing.direction} for ${market.city}`);
        }
        
        // ========================================
        // RAP-HRRR Confirmation Check (when enabled)
        // ========================================
        if (config.SPEED_ARB_REQUIRE_RAP_HRRR_CONFIRMATION && !config.SPEED_ARBITRAGE_MODE) {
            if (!market.city) {
                logger.debug(`Speed arb: No city info for market, skipping RAP-HRRR check`);
            } else if (this.isUsCity(market.city)) {
                if (!this.confirmationManager) {
                    logger.warn(`Speed arb: ConfirmationManager not set, cannot verify RAP-HRRR confirmation`);
                    return null;
                }
                const cityId = market.city.toLowerCase().replace(/\s+/g, '_');
                const cycleHour = forecast.changeTimestamp.getUTCHours();
                const isConfirmed = this.confirmationManager.checkRapHrrrConfirmation(cityId, cycleHour, forecast.changeTimestamp);
                if (!isConfirmed) {
                    logger.debug(`Speed arb: Skipping ${market.city} - waiting for HRRR confirmation`);
                    return null;
                }
            }
        }

        // Check if already captured
        if (this.isOpportunityCaptured(market.market.id, forecast.forecastValue)) {
            return null;
        }

        // Get current price
        const priceHistory = state.priceHistory.yes.history;
        if (priceHistory.length === 0) return null;
        
        const priceYes = priceHistory[priceHistory.length - 1].price;
        const priceNo = 1 - priceYes;

        // Calculate threshold
        let threshold = market.threshold;
        if (threshold === undefined) return null;
        if (market.thresholdUnit === 'C') {
            threshold = (threshold * 9 / 5) + 32;
        }

        // Calculate sigma with dynamic uncertainty
        const daysToEvent = market.targetDate
            ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
            : 3;
        const uncertainty = 1.5 + 0.8 * daysToEvent;
        const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

        if (sigma < config.SPEED_ARB_MIN_SIGMA) return null;

        // Calculate probability
        let forecastProb: number;
        if (market.comparisonType === 'above') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'above', uncertainty);
        } else if (market.comparisonType === 'below') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'below', uncertainty);
        } else {
            return null;
        }

        // ========================================
        // Market Caught-Up Validation
        // Skip if market has already moved to reflect the forecast
        // ========================================
        const priceDiff = Math.abs(forecastProb - priceYes);
        if (priceDiff < 0.02) { // 2% threshold
            logger.debug(`Speed arb: Market caught up for ${market.city} - price ${(priceYes * 100).toFixed(1)}% ≈ forecast ${(forecastProb * 100).toFixed(1)}%`);
            return null;
        }

        // Calculate edge
        const edge = this.edgeCalculator.calculateEdge(market, forecastProb, priceYes, priceNo);
        if (!edge || Math.abs(edge.adjustedEdge) < 0.02) return null;

        // Calculate edge decay
        const decayFactor = this.calculateEdgeDecayFactor(changeAge);
        const decayedEdge = edge.adjustedEdge * decayFactor;
        
        if (Math.abs(decayedEdge) < 0.02) {
            logger.debug(`Speed arb: Edge decayed too much (${(decayedEdge * 100).toFixed(1)}%), skipping`);
            return null;
        }

        // Calculate position size
        let positionSize = config.maxPositionSize * decayFactor * this.calculateUrgencySizeMultiplier(changeAge);
        
        if (sigma >= 2.0) {
            positionSize *= 1.3;
        } else if (sigma >= 1.5) {
            positionSize *= 1.15;
        }
        
        positionSize = Math.min(positionSize, config.maxPositionSize * config.guaranteedPositionMultiplier * 1.5);

        logger.info(`Speed arb: ${market.market.question.substring(0, 50)} | edge=${(edge.adjustedEdge * 100).toFixed(1)}% | decayed=${(decayedEdge * 100).toFixed(1)}% | σ=${sigma.toFixed(1)} | size=$${positionSize.toFixed(2)}`);

        return {
            marketId: edge.marketId,
            side: edge.side,
            size: parseFloat(positionSize.toFixed(2)),
            orderType: 'MARKET',
            urgency: 'HIGH',
            estimatedEdge: decayedEdge,
            confidence: edge.confidence * decayFactor,
            reason: `Speed: ${sigma.toFixed(1)}σ, edge ${(edge.adjustedEdge * 100).toFixed(1)}% (decayed: ${(decayedEdge * 100).toFixed(1)}%)`,
            isGuaranteed: edge.isGuaranteed,
            sigma: sigma,
        };
    }

    /**
     * Calculate edge decay factor based on signal age
     */
    private calculateEdgeDecayFactor(ageMs: number): number {
        if (ageMs > EDGE_DECAY_MAX_AGE_MS) return 0.1;
        const decayFactor = Math.exp(-ageMs / EDGE_DECAY_HALF_LIFE_MS * Math.LN2);
        return Math.max(0.3, decayFactor);
    }

    /**
     * Calculate urgency-based size multiplier
     */
    private calculateUrgencySizeMultiplier(ageMs: number): number {
        if (ageMs < 5000) return URGENCY_SIZE_MULTIPLIER;
        if (ageMs < 15000) return 1.3;
        if (ageMs < 30000) return 1.1;
        if (ageMs < 60000) return 1.0;
        return 0.9;
    }

    /**
     * Scan all markets for opportunities
     */
    detectOpportunities(): EntrySignal[] {
        const markets = this.store.getAllMarkets();
        const opportunities: EntrySignal[] = [];

        for (const market of markets) {
            const signal = this.detectOpportunity(market.market.id);
            if (signal) opportunities.push(signal);
        }

        return opportunities;
    }

    /**
     * Calculate probability using normal CDF
     */
    private calculateProbability(forecastValue: number, threshold: number, comparisonType: 'above' | 'below', dynamicUncertainty?: number): number {
        const uncertainty = dynamicUncertainty ?? 3;
        const z = (forecastValue - threshold) / uncertainty;
        
        if (comparisonType === 'above') {
            return normalCDF(z);
        } else {
            return 1 - normalCDF(z);
        }
    }

    /**
     * Calculate threshold position for a forecast value.
     */
    calculateThresholdPosition(forecastValue: number, threshold: number): ThresholdPosition {
        const distance = forecastValue - threshold;
        return {
            relativeToThreshold: distance > 0.5 ? 'above' : distance < -0.5 ? 'below' : 'at',
            distanceFromThreshold: Math.abs(distance),
            timestamp: new Date(),
        };
    }

    /**
     * Detect if a threshold crossing occurred
     */
    detectThresholdCrossing(previous: ThresholdPosition, current: ThresholdPosition, minCrossingDistance: number): { crossed: boolean; direction: 'up' | 'down' | 'none' } {
        if (previous.relativeToThreshold === current.relativeToThreshold) {
            return { crossed: false, direction: 'none' };
        }

        const hasSufficientDistance = previous.distanceFromThreshold >= minCrossingDistance || current.distanceFromThreshold >= minCrossingDistance;
        if (!hasSufficientDistance) {
            return { crossed: false, direction: 'none' };
        }

        const crossedUp = previous.relativeToThreshold === 'below' && current.relativeToThreshold === 'above';
        const crossedDown = previous.relativeToThreshold === 'above' && current.relativeToThreshold === 'below';

        return {
            crossed: crossedUp || crossedDown,
            direction: crossedUp ? 'up' : crossedDown ? 'down' : 'none',
        };
    }
    
    /**
     * Check if a city is in the US
     */
    private isUsCity(cityName: string | null): boolean {
        if (!cityName) return false;
        const city = KNOWN_CITIES.find(
            c => c.name.toLowerCase() === cityName.toLowerCase() ||
                 c.aliases.some(a => a.toLowerCase() === cityName.toLowerCase())
        );
        return city?.country === 'US';
    }
}

export default SpeedArbitrageStrategy;
