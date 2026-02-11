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
const MIN_SIGMA_FOR_ARBITRAGE = 0.3; // Reduced from 0.5 to capture more marginal edge

// Edge decay configuration
const EDGE_DECAY_HALF_LIFE_MS = 60000;  // 1 minute half-life
const EDGE_DECAY_MAX_AGE_MS = 180000;   // 3 minutes max
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
        this.entryOptimizer = new EntryOptimizer(this.marketModel, this.marketImpactModel);
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

        // Must be a recent change (not first data)
        if (forecast.previousValue === undefined) {
            logger.debug(`Speed arb: Skipping first data point for ${market.city}`);
            return null;
        }

        const changeAge = now - forecast.changeTimestamp.getTime();
        if (!forecast.valueChanged || changeAge > MAX_CHANGE_AGE_MS) {
            return null;
        }

        // ========================================
        // NEW: Threshold-Crossing Detection
        // ========================================
        
        // Check if threshold crossing is required
        const requireThresholdCrossing = config.SPEED_ARB_REQUIRE_THRESHOLD_CROSSING;
        const minCrossingDistance = config.SPEED_ARB_MIN_CROSSING_DISTANCE;

        if (requireThresholdCrossing) {
            // Get threshold in standardized units (°F)
            let threshold = market.threshold;
            if (threshold === undefined) {
                logger.debug(`Speed arb: No threshold defined for ${market.city}`);
                return null;
            }
            if (market.thresholdUnit === 'C') {
                threshold = (threshold * 9 / 5) + 32;
            }

            // Calculate threshold positions
            const prevPosition = this.calculateThresholdPosition(forecast.previousValue, threshold);
            const currPosition = this.calculateThresholdPosition(forecast.forecastValue, threshold);

            // Check for valid threshold crossing
            const crossing = this.detectThresholdCrossing(prevPosition, currPosition, minCrossingDistance);
            
            if (!crossing.crossed) {
                logger.debug(`Speed arb: Forecast change did not cross threshold for ${market.city}`, {
                    previousValue: forecast.previousValue,
                    currentValue: forecast.forecastValue,
                    threshold,
                    prevPosition: prevPosition.relativeToThreshold,
                    currPosition: currPosition.relativeToThreshold,
                });
                return null;
            }

            logger.info(`Speed arb: Threshold crossed ${crossing.direction} for ${market.city}`, {
                previousValue: forecast.previousValue,
                currentValue: forecast.forecastValue,
                threshold,
            });
        }
        
        // ========================================
        // NEW: RAP-HRRR Confirmation Check (when speed arb mode is OFF)
        // ========================================
        
        // When speed arb mode is OFF, require HRRR to confirm RAP data for US cities
        if (!config.SPEED_ARBITRAGE_MODE) {
            // Skip if no city info available
            if (!market.city) {
                logger.debug(`Speed arb: No city info for market, skipping RAP-HRRR check`);
            } else {
                const cityId = market.city.toLowerCase().replace(/\s+/g, '_');
                
                // Check if this is a US city (RAP/HRRR coverage)
                if (this.isUsCity(market.city)) {
                    if (!this.confirmationManager) {
                        logger.warn(
                            `Speed arb: ConfirmationManager not set, cannot verify RAP-HRRR confirmation for ${market.city}`
                        );
                        return null;
                    }
                    
                    // Get the cycle hour from the forecast timestamp
                    const cycleHour = forecast.changeTimestamp.getUTCHours();
                    const runDate = forecast.changeTimestamp;
                    
                    const isConfirmed = this.confirmationManager.checkRapHrrrConfirmation(
                        cityId,
                        cycleHour,
                        runDate
                    );
                    
                    if (!isConfirmed) {
                        logger.debug(
                            `Speed arb: Skipping trade for ${market.city} - waiting for HRRR confirmation of RAP data`
                        );
                        return null;
                    }
                    
                    logger.info(
                        `Speed arb: RAP-HRRR confirmation verified for ${market.city}`
                    );
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

        // Calculate sigma
        const daysToEvent = market.targetDate
            ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
            : 3;
        
        const uncertainty = 1.5 + 0.8 * daysToEvent;
        const sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;

        if (sigma < MIN_SIGMA_FOR_ARBITRAGE) return null;

        // Calculate probability
        let forecastProb: number;
        if (market.comparisonType === 'above') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'above');
        } else if (market.comparisonType === 'below') {
            forecastProb = this.calculateProbability(forecast.forecastValue, threshold, 'below');
        } else {
            return null;
        }

        // Calculate edge
        const edge = this.edgeCalculator.calculateEdge(market, forecastProb, priceYes, priceNo);
        if (!edge || Math.abs(edge.adjustedEdge) < 0.02) return null;

        // Calculate edge decay based on signal age
        const decayFactor = this.calculateEdgeDecayFactor(changeAge);
        const decayedEdge = edge.adjustedEdge * decayFactor;
        
        // Skip if decayed edge is too small
        if (Math.abs(decayedEdge) < 0.02) {
            logger.debug(`Speed arb: Edge decayed too much (${(decayedEdge * 100).toFixed(1)}%), skipping`);
            return null;
        }

        // Calculate urgency-based size multiplier
        const urgencyMultiplier = this.calculateUrgencySizeMultiplier(changeAge);
        
        // Calculate final position size with decay and urgency
        let positionSize = config.maxPositionSize * decayFactor * urgencyMultiplier;
        
        // Boost size for high-sigma opportunities
        if (sigma >= 2.0) {
            positionSize *= 1.3;  // 30% boost for high confidence
        } else if (sigma >= 1.5) {
            positionSize *= 1.15;  // 15% boost for medium-high confidence
        }
        
        // Cap at maximum
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
            decayFactor: parseFloat(decayFactor.toFixed(3))
        };
    }

    /**
     * Calculate edge decay factor based on signal age
     * Uses exponential decay with configurable half-life
     */
    private calculateEdgeDecayFactor(ageMs: number): number {
        if (ageMs > EDGE_DECAY_MAX_AGE_MS) {
            return 0.1;  // Minimum 10% after max age
        }
        
        // Exponential decay: factor = 0.5^(age/half_life)
        const decayFactor = Math.exp(-ageMs / EDGE_DECAY_HALF_LIFE_MS * Math.LN2);
        
        // Ensure minimum factor of 0.3
        return Math.max(0.3, decayFactor);
    }

    /**
     * Calculate urgency-based size multiplier
     * Higher multiplier for fresh signals to capture maximum alpha
     */
    private calculateUrgencySizeMultiplier(ageMs: number): number {
        if (ageMs < 5000) {
            // First 5 seconds: Maximum urgency
            return URGENCY_SIZE_MULTIPLIER;
        } else if (ageMs < 15000) {
            // 5-15 seconds: High urgency
            return 1.3;
        } else if (ageMs < 30000) {
            // 15-30 seconds: Medium urgency
            return 1.1;
        } else if (ageMs < 60000) {
            // 30-60 seconds: Low urgency
            return 1.0;
        } else {
            // After 1 minute: Normal sizing
            return 0.9;
        }
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
    private calculateProbability(forecastValue: number, threshold: number, comparisonType: 'above' | 'below'): number {
        const UNCERTAINTY = 3;
        const z = (forecastValue - threshold) / UNCERTAINTY;
        
        if (comparisonType === 'above') {
            return normalCDF(z);
        } else {
            return 1 - normalCDF(z);
        }
    }

    /**
     * Calculate threshold position for a forecast value.
     * Returns the position relative to the threshold.
     */
    calculateThresholdPosition(forecastValue: number, threshold: number): ThresholdPosition {
        const distance = forecastValue - threshold;
        const now = new Date();

        return {
            relativeToThreshold: distance > 0.5 ? 'above' : distance < -0.5 ? 'below' : 'at',
            distanceFromThreshold: Math.abs(distance),
            timestamp: now,
        };
    }

    /**
     * Detect if a threshold crossing occurred between previous and current positions.
     * Returns crossing status and direction.
     */
    detectThresholdCrossing(
        previous: ThresholdPosition,
        current: ThresholdPosition,
        minCrossingDistance: number
    ): { crossed: boolean; direction: 'up' | 'down' | 'none' } {
        // Same side of threshold - no crossing
        if (previous.relativeToThreshold === current.relativeToThreshold) {
            return { crossed: false, direction: 'none' };
        }

        // Check if the crossing is significant enough (not just noise near threshold)
        // At least one position should be sufficiently far from threshold
        const hasSufficientDistance = 
            previous.distanceFromThreshold >= minCrossingDistance ||
            current.distanceFromThreshold >= minCrossingDistance;

        if (!hasSufficientDistance) {
            return { crossed: false, direction: 'none' };
        }

        // Determine direction
        const crossedUp = previous.relativeToThreshold === 'below' && 
                          current.relativeToThreshold === 'above';
        const crossedDown = previous.relativeToThreshold === 'above' && 
                            current.relativeToThreshold === 'below';

        return {
            crossed: crossedUp || crossedDown,
            direction: crossedUp ? 'up' : crossedDown ? 'down' : 'none',
        };
    }
    
    /**
     * Check if a city is in the US (RAP/HRRR coverage area)
     * RAP and HRRR only cover North America
     */
    private isUsCity(cityName: string | null): boolean {
        if (!cityName) return false;
        
        // Look up city in KNOWN_CITIES
        const city = KNOWN_CITIES.find(
            c => c.name.toLowerCase() === cityName.toLowerCase() ||
                 c.aliases.some(a => a.toLowerCase() === cityName.toLowerCase())
        );
        
        // If city is found and country is US, it's a US city
        return city?.country === 'US';
    }
}

export default SpeedArbitrageStrategy;
