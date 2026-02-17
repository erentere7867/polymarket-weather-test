/**
 * Opportunity Detector
 * Compares weather forecasts to market prices to find trading opportunities
 */

import { WeatherService } from '../weather/index.js';
import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { DataStore } from '../realtime/data-store.js';

// Threshold for considering market "caught up" to the forecast
const MARKET_CAUGHT_UP_THRESHOLD = 0.02; // If price within 2% of probability, market caught up - trade even when market has moved partially

// Default significant change (fallback)
const DEFAULT_SIGNIFICANT_CHANGE = 1.0;

/**
 * Price velocity metrics for late-trade detection
 */
interface PriceVelocity {
    change5m: number;        // Price change in last 5 minutes (as decimal, e.g., 0.02 = 2%)
    change1m: number;        // Price change in last 1 minute
    direction: 'for' | 'against' | 'neutral';  // Relative to our edge
    isLate: boolean;         // True if price moving against us rapidly
}

/**
 * Result of late-trade detection check
 */
interface LateTradeCheck {
    isLate: boolean;
    reason: string;
    adjustedEdge: number;    // Edge reduced if partially late
    priceVelocity: PriceVelocity;
}

interface CapturedOpportunity {
    forecastValue: number;
    capturedAt: Date;
    side: 'buy_yes' | 'buy_no';
}

// Track rejection reasons for debugging
interface RejectionStats {
    marketCaughtUp: number;
    alreadyCaptured: number;
    forecastChangeBelowThreshold: number;
    totalChecked: number;
}

export class OpportunityDetector {
    private weatherService: WeatherService;
    private store: DataStore | null;

    // Track opportunities we've already acted on - prevents re-buying at higher prices
    private capturedOpportunities: Map<string, CapturedOpportunity> = new Map();
    
    // TTL for captured opportunities to prevent memory leaks
    private readonly CAPTURE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    
    // Track rejection reasons for debugging
    private rejectionStats: RejectionStats = {
        marketCaughtUp: 0,
        alreadyCaptured: 0,
        forecastChangeBelowThreshold: 0,
        totalChecked: 0,
    };
    private lastRejectionLogTime: number = 0;
    
    // Prefetched weather data cache for batch processing (~200ms savings)
    private prefetchedWeather: Map<string, {
        high: number | null;
        low: number | null;
        precipProbability: number | null;
        fetchedAt: number;
    }> = new Map();
    private readonly PREFETCH_TTL_MS = 60000; // 1 minute TTL for prefetched data

    // Price history for late-trade detection (marketId -> price history)
    private priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();
    private readonly PRICE_HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // Keep 10 minutes of price history

    constructor(store?: DataStore) {
        this.weatherService = new WeatherService();
        this.store = store ?? null;
    }

    /**
     * Record market price for velocity calculation
     * Call this whenever we get a market price update
     */
    recordPrice(marketId: string, price: number): void {
        const now = Date.now();
        
        if (!this.priceHistory.has(marketId)) {
            this.priceHistory.set(marketId, []);
        }
        
        const history = this.priceHistory.get(marketId)!;
        history.push({ price, timestamp: now });
        
        // Clean up old entries
        while (history.length > 0 && now - history[0].timestamp > this.PRICE_HISTORY_MAX_AGE_MS) {
            history.shift();
        }
    }

    /**
     * Calculate price velocity from price history
     * Returns metrics about how fast and in what direction price is moving
     */
    calculatePriceVelocity(marketId: string, currentPrice: number, edge: number): PriceVelocity {
        const history = this.priceHistory.get(marketId) || [];
        const now = Date.now();
        
        // Get closest price to 5 minutes ago (find the entry closest to 5min mark)
        const target5m = now - 5 * 60 * 1000;
        let price5mAgo: { price: number; timestamp: number } | undefined;
        let best5mDiff = Infinity;
        for (const h of history) {
            const diff = Math.abs(h.timestamp - target5m);
            if (diff < best5mDiff && h.timestamp <= now) {
                best5mDiff = diff;
                price5mAgo = h;
            }
        }
        // Only use if within 2 minutes of target (3-7 min ago)
        const change5m = (price5mAgo && best5mDiff < 2 * 60 * 1000) ? currentPrice - price5mAgo.price : 0;
        
        // Get closest price to 1 minute ago
        const target1m = now - 1 * 60 * 1000;
        let price1mAgo: { price: number; timestamp: number } | undefined;
        let best1mDiff = Infinity;
        for (const h of history) {
            const diff = Math.abs(h.timestamp - target1m);
            if (diff < best1mDiff && h.timestamp <= now) {
                best1mDiff = diff;
                price1mAgo = h;
            }
        }
        // Only use if within 30 seconds of target (30s-90s ago)
        const change1m = (price1mAgo && best1mDiff < 30 * 1000) ? currentPrice - price1mAgo.price : 0;
        
        // Determine direction relative to our edge
        // If edge > 0 (we want to buy YES), price going UP is against us
        // If edge < 0 (we want to buy NO), price going DOWN is against us
        let direction: 'for' | 'against' | 'neutral';
        const absChange = Math.abs(change5m);
        
        if (absChange < 0.005) {
            direction = 'neutral';
        } else if (edge > 0) {
            // We want to buy YES, so price increasing is bad
            direction = change5m > 0 ? 'against' : 'for';
        } else {
            // We want to buy NO, so price decreasing is bad
            direction = change5m < 0 ? 'against' : 'for';
        }
        
        // Check if this is a "late" trade (price moving against us rapidly)
        const isLate = direction === 'against' && absChange >= config.LATE_TRADE_PRICE_VELOCITY_THRESHOLD;
        
        return {
            change5m,
            change1m,
            direction,
            isLate
        };
    }

    /**
     * Check if trade is "late" (information already priced in)
     * Returns adjusted edge and reason if late
     */
    isLateTrade(
        market: ParsedWeatherMarket,
        edge: number,
        forecastTimestamp: Date | undefined
    ): LateTradeCheck {
        const marketId = market.market.id;
        const currentPrice = market.yesPrice;
        
        // Calculate price velocity
        const priceVelocity = this.calculatePriceVelocity(marketId, currentPrice, edge);
        
        // Check 1: Time since forecast
        const timeSinceForecast = forecastTimestamp ? Date.now() - forecastTimestamp.getTime() : Infinity;
        const forecastTooOld = timeSinceForecast > config.LATE_TRADE_MIN_TIME_SINCE_FORECAST;
        
        // Check 2: Price velocity
        const priceMovingAgainst = priceVelocity.direction === 'against';
        const rapidMove = Math.abs(priceVelocity.change5m) >= config.LATE_TRADE_PRICE_VELOCITY_THRESHOLD;
        
        // Determine if late
        let isLate = false;
        let reason = '';
        let adjustedEdge = edge;
        
        if (forecastTooOld) {
            isLate = true;
            reason = `Forecast too old: ${(timeSinceForecast / 1000).toFixed(0)}s (max: ${config.LATE_TRADE_MIN_TIME_SINCE_FORECAST / 1000}s)`;
        } else if (priceVelocity.isLate) {
            isLate = true;
            reason = `Late trade detected: Price moved ${(Math.abs(priceVelocity.change5m) * 100).toFixed(1)}% in 5 min (threshold: ${(config.LATE_TRADE_PRICE_VELOCITY_THRESHOLD * 100).toFixed(0)}%)`;
            
            // Reduce edge based on how much price has moved against us
            const edgeReduction = Math.abs(priceVelocity.change5m) * config.LATE_TRADE_EDGE_DECAY_FACTOR;
            adjustedEdge = edge > 0
                ? Math.max(0, edge - edgeReduction)
                : Math.min(0, edge + edgeReduction);
            
            if (Math.abs(adjustedEdge) < Math.abs(edge)) {
                logger.info(`Adjusting edge from ${(edge * 100).toFixed(1)}% to ${(adjustedEdge * 100).toFixed(1)}% due to price velocity`);
            }
        } else if (priceMovingAgainst && rapidMove) {
            // Price moving against us but not quite at threshold - still reduce edge
            const edgeReduction = Math.abs(priceVelocity.change5m) * config.LATE_TRADE_EDGE_DECAY_FACTOR * 0.5;
            adjustedEdge = edge > 0
                ? Math.max(0, edge - edgeReduction)
                : Math.min(0, edge + edgeReduction);
            
            reason = `Price moving against position: ${(priceVelocity.change5m * 100).toFixed(1)}% in 5 min`;
            logger.warn(`⚠️ ${reason} - reducing edge`);
        }
        
        return {
            isLate,
            reason,
            adjustedEdge,
            priceVelocity
        };
    }
    
    /**
     * Cleanup stale captured opportunities to prevent memory leaks
     */
    private cleanupStaleCaptures(): void {
        const now = Date.now();
        for (const [key, capture] of this.capturedOpportunities.entries()) {
            if (now - capture.capturedAt.getTime() > this.CAPTURE_TTL_MS) {
                this.capturedOpportunities.delete(key);
            }
        }
    }
    
    /**
     * Prefetch weather data for all unique cities in markets
     * Call this before batch processing to parallelize API calls
     */
    async prefetchWeatherData(markets: ParsedWeatherMarket[]): Promise<void> {
        const now = Date.now();
        
        // Get unique cities with their target dates
        const cityDateKeys = new Map<string, { city: string; targetDate: Date }>();
        for (const market of markets) {
            if (market.city && market.targetDate) {
                const key = `${market.city}_${market.targetDate.toDateString()}`;
                if (!cityDateKeys.has(key)) {
                    cityDateKeys.set(key, { city: market.city, targetDate: market.targetDate });
                }
            }
        }
        
        // Fetch weather data for all unique city/date combinations in parallel
        const fetchPromises = Array.from(cityDateKeys.values()).map(async ({ city, targetDate }) => {
            const key = `${city}_${targetDate.toDateString()}`;
            
            // Skip if we have fresh cached data
            const cached = this.prefetchedWeather.get(key);
            if (cached && (now - cached.fetchedAt) < this.PREFETCH_TTL_MS) {
                return;
            }
            
            try {
                // Fetch all weather data types in parallel for this city
                const [high, low, forecast] = await Promise.all([
                    this.weatherService.getExpectedHigh(city, targetDate).catch(() => null),
                    this.weatherService.getExpectedLow(city, targetDate).catch(() => null),
                    this.weatherService.getForecastByCity(city).catch(() => null),
                ]);
                
                // Extract precipitation from forecast if available
                let precipProbability: number | null = null;
                if (forecast) {
                    const targetDateObj = new Date(targetDate);
                    targetDateObj.setUTCHours(0, 0, 0, 0);
                    const targetDateStr = targetDateObj.toISOString().split('T')[0];
                    const dayForecasts = forecast.hourly.filter(h => {
                        const hourDate = new Date(h.timestamp);
                        // Use date string comparison to avoid timestamp mismatch issues
                        return hourDate.toISOString().split('T')[0] === targetDateStr;
                    });
                    if (dayForecasts.length > 0) {
                        precipProbability = Math.max(...dayForecasts.map(h => h.probabilityOfPrecipitation));
                    }
                }
                
                this.prefetchedWeather.set(key, {
                    high,
                    low,
                    precipProbability,
                    fetchedAt: now,
                });
            } catch (error) {
                logger.warn(`Failed to prefetch weather for ${city}`, { error: (error as Error).message });
            }
        });
        
        await Promise.all(fetchPromises);
    }
    
    /**
     * Get prefetched weather data for a city/date
     */
    private getPrefetchedWeather(city: string, targetDate: Date): {
        high: number | null;
        low: number | null;
        precipProbability: number | null;
    } | null {
        const key = `${city}_${targetDate.toDateString()}`;
        const cached = this.prefetchedWeather.get(key);
        
        if (!cached || (Date.now() - cached.fetchedAt) >= this.PREFETCH_TTL_MS) {
            return null;
        }
        
        return cached;
    }

    private getStoredForecast(market: ParsedWeatherMarket): {
        probability: number;
        forecastValue: number;
        confidence: number;
    } | null {
        if (!this.store) return null;

        const state = this.store.getMarketState(market.market.id);
        const snapshot = state?.lastForecast;
        if (!snapshot) return null;

        if (snapshot.probability === undefined || snapshot.forecastValue === undefined) return null;

        const source = snapshot.weatherData?.source;
        const confidence = source === 'S3_FILE' ? 1.0 : 0.7;

        return {
            probability: snapshot.probability,
            forecastValue: snapshot.forecastValue,
            confidence,
        };
    }
    
    /**
     * Get rejection statistics for debugging
     */
    getRejectionStats(): RejectionStats {
        return { ...this.rejectionStats };
    }
    
    /**
     * Reset rejection statistics
     */
    resetRejectionStats(): void {
        this.rejectionStats = {
            marketCaughtUp: 0,
            alreadyCaptured: 0,
            forecastChangeBelowThreshold: 0,
            totalChecked: 0,
        };
    }
    
    /**
     * Log rejection reasons periodically (every 15 minutes, only if there are rejections)
     */
    private logRejectionStats(): void {
        const now = Date.now();
        const hasRejections = this.rejectionStats.totalChecked > 0;
        if (hasRejections && now - this.lastRejectionLogTime > 15 * 60 * 1000) {
            logger.info('📊 Opportunity Rejection Stats (last 15 min)', {
                totalChecked: this.rejectionStats.totalChecked,
                marketCaughtUp: this.rejectionStats.marketCaughtUp,
                alreadyCaptured: this.rejectionStats.alreadyCaptured,
                forecastChangeBelowThreshold: this.rejectionStats.forecastChangeBelowThreshold,
            });
            this.resetRejectionStats();
            this.lastRejectionLogTime = now;
        }
    }

    /**
     * Mark an opportunity as captured after successful trade
     */
    markOpportunityCaptured(marketId: string, forecastValue: number, side: 'buy_yes' | 'buy_no'): void {
        this.capturedOpportunities.set(marketId, {
            forecastValue,
            capturedAt: new Date(),
            side
        });
        // Forecast values disabled per user request
        logger.info(`📌 Opportunity captured: ${marketId} (${side})`);
    }

    /**
     * Get significant change threshold for a metric
     */
    private getSignificantChangeThreshold(metricType: string): number {
        switch (metricType) {
            case 'temperature_high':
            case 'temperature_low':
            case 'temperature_threshold':
            case 'temperature_range':
                return 1.0; // 1°F
            case 'precipitation':
                return 5; // 5% probability change
            default:
                return DEFAULT_SIGNIFICANT_CHANGE;
        }
    }

    /**
     * Check if opportunity is already captured and whether market has caught up
     */
    private shouldSkipOpportunity(
        market: ParsedWeatherMarket,
        currentForecastValue: number | undefined,
        marketProbability: number,
        forecastProbability: number
    ): { skip: boolean; reason: string } {
        this.rejectionStats.totalChecked++;
        
        // Check 1: Has market caught up to the probability?
        const priceDiff = Math.abs(marketProbability - forecastProbability);
        if (priceDiff < MARKET_CAUGHT_UP_THRESHOLD) {
            this.rejectionStats.marketCaughtUp++;
            this.logRejectionStats();
            return {
                skip: true,
                reason: `Market caught up: price ${(marketProbability * 100).toFixed(1)}% ≈ forecast ${(forecastProbability * 100).toFixed(1)}% (diff ${(priceDiff * 100).toFixed(1)}% < ${(MARKET_CAUGHT_UP_THRESHOLD * 100).toFixed(0)}%)`
            };
        }

        // Check 2: Have we already captured this opportunity?
        const captured = this.capturedOpportunities.get(market.market.id);
        if (!captured || currentForecastValue === undefined) {
            return { skip: false, reason: '' };
        }

        // Special check for Range Markets: If forecast moved INTO the winning range, force re-entry
        if (market.metricType === 'temperature_range' && market.minThreshold !== undefined && market.maxThreshold !== undefined) {
            const min = market.thresholdUnit === 'C' ? (market.minThreshold * 9 / 5) + 32 : market.minThreshold;
            const max = market.thresholdUnit === 'C' ? (market.maxThreshold * 9 / 5) + 32 : market.maxThreshold;

            const wasIn = captured.forecastValue >= min && captured.forecastValue <= max;
            const isIn = currentForecastValue >= min && currentForecastValue <= max;

            if (!wasIn && isIn) {
                // Forecast moved INTO range - Re-enter!
                this.capturedOpportunities.delete(market.market.id);
                // Forecast values disabled per user request
                logger.info(`🔄 New forecast for ${market.city} (Range): Moved INTO range, forcing re-entry`);
                return { skip: false, reason: '' };
            }
        }

        // Allow re-entry only if forecast changed significantly (new opportunity)
        const threshold = this.getSignificantChangeThreshold(market.metricType);
        const forecastDiff = Math.abs(currentForecastValue - captured.forecastValue);

        if (forecastDiff >= threshold) {
            // New forecast! Clear captured flag
            this.capturedOpportunities.delete(market.market.id);
            // Forecast values disabled per user request
            logger.info(`🔄 New forecast for ${market.city} (${market.metricType}): allowing re-entry`);
            return { skip: false, reason: '' };
        }

        this.rejectionStats.alreadyCaptured++;
        this.rejectionStats.forecastChangeBelowThreshold++;
        this.logRejectionStats();
        return {
            skip: true,
            reason: `Already captured - forecast change below threshold`
        };
    }

    /**
     * Clear captured opportunity (e.g., when market resolves)
     */
    clearCapturedOpportunity(marketId: string): void {
        this.capturedOpportunities.delete(marketId);
    }

    /**
     * Analyze a weather market to find trading opportunity
     */
    async analyzeMarket(market: ParsedWeatherMarket): Promise<TradingOpportunity | null> {
        if (!market.city) {
            return null;
        }

        try {
            let forecastProbability: number | null = null;
            let forecastValue: number | undefined;
            let forecastValueUnit: string | undefined;
            let weatherDataSource: 'noaa' | 'openweather' = 'noaa';
            let confidence = 0.7; // Default confidence

            const stored = this.getStoredForecast(market);
            if (stored) {
                forecastProbability = stored.probability;
                forecastValue = stored.forecastValue;
                confidence = stored.confidence;
                forecastValueUnit = market.metricType === 'precipitation' ? '%' : '°F';
            }

            if (forecastProbability === null) {
                switch (market.metricType) {
                    case 'temperature_high':
                    case 'temperature_threshold': {
                        const result = await this.analyzeTemperatureMarket(market);
                        if (result) {
                            forecastProbability = result.probability;
                            forecastValue = result.forecastValue;
                            forecastValueUnit = '°F';
                            weatherDataSource = result.source;
                            confidence = result.confidence;
                        }
                        break;
                    }
                    case 'temperature_low': {
                        const lowResult = await this.analyzeTemperatureLowMarket(market);
                        if (lowResult) {
                            forecastProbability = lowResult.probability;
                            forecastValue = lowResult.forecastValue;
                            forecastValueUnit = '°F';
                            weatherDataSource = lowResult.source;
                            confidence = lowResult.confidence;
                        }
                        break;
                    }
                    case 'temperature_range': {
                        const rangeResult = await this.analyzeTemperatureRangeMarket(market);
                        if (rangeResult) {
                            forecastProbability = rangeResult.probability;
                            forecastValue = rangeResult.forecastValue;
                            forecastValueUnit = '°F';
                            weatherDataSource = rangeResult.source;
                            confidence = rangeResult.confidence;
                        }
                        break;
                    }
                    case 'precipitation': {
                        const precipResult = await this.analyzePrecipitationMarket(market);
                        if (precipResult) {
                            forecastProbability = precipResult.probability;
                            forecastValue = precipResult.forecastValue;
                            forecastValueUnit = '%';
                            weatherDataSource = precipResult.source;
                            confidence = precipResult.confidence;
                        }
                        break;
                    }
                    default:
                        return null;
                }
            }

            if (forecastProbability === null) {
                return null;
            }

            // DEFENSIVE VALIDATION: Check if comparisonType aligns with forecast vs threshold
            // This catches bugs like: forecast=66°F, threshold=64°F, comparisonType='below' (WRONG!)
            if (market.threshold !== undefined && forecastValue !== undefined) {
                const validationResult = this.validateComparisonType(
                    market.comparisonType,
                    market.threshold,
                    forecastValue,
                    market.thresholdUnit,
                    market.metricType
                );
                
                if (!validationResult.isValid) {
                    logger.error(
                        `⚠️ COMPARISON TYPE MISMATCH DETECTED: ${market.market.question}`,
                        {
                            comparisonType: market.comparisonType,
                            threshold: market.threshold,
                            thresholdUnit: market.thresholdUnit,
                            forecastValue,
                            issue: validationResult.issue,
                            expectedComparisonType: validationResult.expectedComparisonType
                        }
                    );
                    // Don't trade on markets with mismatched comparison types
                    return null;
                }
            }

            // Market implied probability (YES price = probability of YES outcome)
            const marketProbability = market.yesPrice;

            // Normalize threshold to Fahrenheit if needed for guaranteed check
            let normalizedThreshold = market.threshold;
            if (market.threshold !== undefined && market.thresholdUnit === 'C') {
                normalizedThreshold = (market.threshold * 9 / 5) + 32;
            }

            // Normalize min/max for range
            let normalizedMin = market.minThreshold;
            let normalizedMax = market.maxThreshold;
            if (market.thresholdUnit === 'C') {
                if (normalizedMin !== undefined) normalizedMin = (normalizedMin * 9 / 5) + 32;
                if (normalizedMax !== undefined) normalizedMax = (normalizedMax * 9 / 5) + 32;
            }

            // Check for guaranteed outcome (forecast far beyond threshold)
            const guaranteedResult = this.isGuaranteedOutcome(
                forecastValue,
                normalizedThreshold,
                market.metricType,
                market.comparisonType,
                normalizedMin,
                normalizedMax
            );

            // If guaranteed, override probability to 1.0 or 0.0
            let finalProbability = forecastProbability;
            let isGuaranteed = false;
            let certaintySigma: number | undefined;

            if (guaranteedResult) {
                isGuaranteed = true;
                certaintySigma = guaranteedResult.sigma;
                finalProbability = guaranteedResult.probability;
                confidence = 1.0; // Maximum confidence for guaranteed outcomes
                logger.info(`🎯 GUARANTEED OUTCOME detected for ${market.city}`, {
                    forecastValue,
                    threshold: market.threshold,
                    range: market.minThreshold ? `[${market.minThreshold}, ${market.maxThreshold}]` : undefined,
                    sigma: certaintySigma.toFixed(2),
                    guaranteedProbability: finalProbability,
                    marketProbability: marketProbability.toFixed(3),
                });
            }

            // Check if we should skip this opportunity (already captured or market caught up)
            const skipCheck = this.shouldSkipOpportunity(
                market,
                forecastValue,
                marketProbability,
                finalProbability
            );
            // Snapshot prices at detection time to prevent race conditions during execution
            const snapshotYesPrice = market.yesPrice;
            const snapshotNoPrice = market.noPrice;
            const snapshotTimestamp = new Date();

            if (skipCheck.skip) {
                // Return a non-trade opportunity with the skip reason for debugging
                return {
                    market,
                    forecastProbability: finalProbability,
                    marketProbability,
                    edge: finalProbability - marketProbability,
                    action: 'none',
                    confidence,
                    reason: `Skipped: ${skipCheck.reason}`,
                    weatherDataSource,
                    forecastValue,
                    forecastValueUnit,
                    isGuaranteed,
                    certaintySigma,
                    snapshotYesPrice,
                    snapshotNoPrice,
                    snapshotTimestamp,
                };
            }

            // Record current price for velocity tracking
            this.recordPrice(market.market.id, market.yesPrice);

            // Edge calculation: positive = market underprices YES, negative = market overprices YES
            let edge = finalProbability - marketProbability;
            
            // Check for late trade (information already priced in)
            // Use actual forecast timestamp from DataStore, not snapshotTimestamp (which is always "now")
            let actualForecastTimestamp: Date | undefined;
            if (this.store) {
                const marketState = this.store.getMarketState(market.market.id);
                actualForecastTimestamp = marketState?.lastForecast?.changeTimestamp;
            }
            const lateTradeCheck = this.isLateTrade(market, edge, actualForecastTimestamp);
            
            if (lateTradeCheck.isLate) {
                logger.warn(`⚠️ ${lateTradeCheck.reason}`);
                
                // Use adjusted edge from late trade check
                edge = lateTradeCheck.adjustedEdge;
                
                // If edge was reduced to near zero, don't trade
                if (Math.abs(edge) < 0.02) {
                    logger.info(`Trade blocked due to late detection: adjusted edge ${(edge * 100).toFixed(1)}% too small`);
                    return {
                        market,
                        forecastProbability: finalProbability,
                        marketProbability,
                        edge,
                        action: 'none',
                        confidence: confidence * 0.5, // Reduced confidence for late trades
                        reason: `Late trade blocked: ${lateTradeCheck.reason}`,
                        weatherDataSource,
                        forecastValue,
                        forecastValueUnit,
                        isGuaranteed,
                        certaintySigma,
                        snapshotYesPrice,
                        snapshotNoPrice,
                        snapshotTimestamp,
                    };
                }
            }
            
            const absEdge = Math.abs(edge);

            // Determine action based on edge
            let action: TradingOpportunity['action'] = 'none';
            let reason = '';

            // For guaranteed outcomes, always trade if there's meaningful edge
            // For regular opportunities, use the configured threshold
            const effectiveThreshold = isGuaranteed ? 0.05 : config.minEdgeThreshold;

            if (absEdge >= effectiveThreshold) {
                // SAFETY VALIDATION: Ensure action aligns with forecast vs threshold
                // This is an additional check to prevent contradictory trades
                const safetyCheck = this.validateTradeAction(
                    action,
                    forecastValue,
                    normalizedThreshold,
                    market.comparisonType,
                    market.metricType
                );
                
                if (!safetyCheck.isValid) {
                    logger.error(
                        `⚠️ SAFETY VALIDATION FAILED: ${market.market.question}`,
                        {
                            action,
                            forecastValue,
                            threshold: normalizedThreshold,
                            comparisonType: market.comparisonType,
                            issue: safetyCheck.issue
                        }
                    );
                    // Don't execute trade that contradicts the forecast
                    action = 'none';
                    reason = `Safety check failed: ${safetyCheck.issue}`;
                }
            } else {
                reason = `Edge ${(absEdge * 100).toFixed(1)}% below threshold ${(effectiveThreshold * 100).toFixed(0)}%`;
            }

            return {
                market,
                forecastProbability: finalProbability,
                marketProbability,
                edge,
                action,
                confidence,
                reason,
                weatherDataSource,
                forecastValue,
                forecastValueUnit,
                isGuaranteed,
                certaintySigma,
                snapshotYesPrice,
                snapshotNoPrice,
                snapshotTimestamp,
            };
        } catch (error) {
            logger.error(`Failed to analyze market: ${market.market.question}`, {
                error: (error as Error).message,
            });
            return null;
        }
    }

    /**
     * Analyze a temperature range market (Between X and Y)
     */
    private async analyzeTemperatureRangeMarket(market: ParsedWeatherMarket): Promise<{
        probability: number;
        forecastValue: number;
        source: 'noaa' | 'openweather';
        confidence: number;
    } | null> {
        if (!market.city || market.minThreshold === undefined || market.maxThreshold === undefined) {
            return null;
        }

        const targetDate = market.targetDate || new Date();

        try {
            // "Between X and Y" usually refers to the HIGH temperature unless specified otherwise
            const forecastHigh = await this.weatherService.getExpectedHigh(market.city, targetDate);

            if (forecastHigh === null) {
                return null;
            }

            let probability: number;
            // Dynamic uncertainty based on days to event
            const daysAhead = Math.max(0, (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const uncertainty = 1.5 + 0.8 * daysAhead; // 1.5°F day-0, 3.9°F day-3, 7.1°F day-7

            // Normalize thresholds to F
            let minF = market.minThreshold;
            let maxF = market.maxThreshold;
            if (market.thresholdUnit === 'C') {
                minF = (market.minThreshold * 9 / 5) + 32;
                maxF = (market.maxThreshold * 9 / 5) + 32;
            }

            // Probability that temp is >= min AND <= max
            // P(X >= min) - P(X > max)
            const probAboveMin = this.weatherService.calculateTempExceedsProbability(
                forecastHigh,
                minF,
                uncertainty
            );

            const probAboveMax = this.weatherService.calculateTempExceedsProbability(
                forecastHigh,
                maxF,
                uncertainty
            );

            probability = probAboveMin - probAboveMax;

            // Ensure valid probability
            probability = Math.max(0, Math.min(1, probability));

            const confidence = Math.max(0.3, 0.9 - daysAhead * 0.1);

            return {
                probability,
                forecastValue: forecastHigh,
                source: 'noaa',
                confidence,
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Analyze a temperature high market (uses prefetched data when available)
     */
    private async analyzeTemperatureMarket(market: ParsedWeatherMarket): Promise<{
        probability: number;
        forecastValue: number;
        source: 'noaa' | 'openweather';
        confidence: number;
    } | null> {
        if (!market.city || !market.threshold) {
            return null;
        }

        const targetDate = market.targetDate || new Date();

        try {
            // Check prefetched data first for ~200ms savings
            const prefetched = this.getPrefetchedWeather(market.city, targetDate);
            const forecastHigh = prefetched?.high ?? await this.weatherService.getExpectedHigh(market.city, targetDate);

            if (forecastHigh === null) {
                logger.warn(`No temperature forecast available for ${market.city}`);
                return null;
            }

            // Calculate probability based on comparison type
            let probability: number;
            // Dynamic uncertainty based on days to event
            const daysAhead = Math.max(0, (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const uncertainty = 1.5 + 0.8 * daysAhead; // 1.5°F day-0, 3.9°F day-3, 7.1°F day-7

            // Normalize threshold to F
            let thresholdF = market.threshold;
            if (market.thresholdUnit === 'C') {
                thresholdF = (market.threshold * 9 / 5) + 32;
            }

            if (market.comparisonType === 'above') {
                // Probability that temp will be ABOVE threshold
                probability = this.weatherService.calculateTempExceedsProbability(
                    forecastHigh,
                    thresholdF,
                    uncertainty
                );
            } else {
                // Probability that temp will be BELOW threshold
                probability = 1 - this.weatherService.calculateTempExceedsProbability(
                    forecastHigh,
                    thresholdF,
                    uncertainty
                );
            }

            // Confidence decreases with forecast distance
            const confidence = Math.max(0.3, 0.9 - daysAhead * 0.1);

            logger.debug(`Temperature analysis for ${market.city}`, {
                forecastHigh,
                threshold: market.threshold,
                comparisonType: market.comparisonType,
                probability: probability.toFixed(3),
                confidence: confidence.toFixed(2),
            });

            return {
                probability,
                forecastValue: forecastHigh,
                source: 'noaa', // Primary source
                confidence,
            };
        } catch (error) {
            logger.error(`Temperature analysis failed for ${market.city}`, {
                error: (error as Error).message,
            });
            return null;
        }
    }

    /**
     * Analyze a temperature low market
     */
    private async analyzeTemperatureLowMarket(market: ParsedWeatherMarket): Promise<{
        probability: number;
        forecastValue: number;
        source: 'noaa' | 'openweather';
        confidence: number;
    } | null> {
        if (!market.city || !market.threshold) {
            return null;
        }

        const targetDate = market.targetDate || new Date();

        try {
            // Check prefetched data first for ~200ms savings
            const prefetched = this.getPrefetchedWeather(market.city, targetDate);
            const forecastLow = prefetched?.low ?? await this.weatherService.getExpectedLow(market.city, targetDate);

            if (forecastLow === null) {
                return null;
            }

            let probability: number;
            // Dynamic uncertainty based on days to event
            const daysAhead = Math.max(0, (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const uncertainty = 1.5 + 0.8 * daysAhead; // 1.5°F day-0, 3.9°F day-3, 7.1°F day-7

            // Normalize threshold to F
            let thresholdF = market.threshold;
            if (market.thresholdUnit === 'C') {
                thresholdF = (market.threshold * 9 / 5) + 32;
            }

            if (market.comparisonType === 'below') {
                probability = 1 - this.weatherService.calculateTempExceedsProbability(
                    forecastLow,
                    thresholdF,
                    uncertainty
                );
            } else {
                probability = this.weatherService.calculateTempExceedsProbability(
                    forecastLow,
                    thresholdF,
                    uncertainty
                );
            }

            const confidence = Math.max(0.3, 0.9 - daysAhead * 0.1);

            return {
                probability,
                forecastValue: forecastLow,
                source: 'noaa',
                confidence,
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Analyze a precipitation market
     */
    private async analyzePrecipitationMarket(market: ParsedWeatherMarket): Promise<{
        probability: number;
        forecastValue: number;
        source: 'noaa' | 'openweather';
        confidence: number;
    } | null> {
        if (!market.city) {
            return null;
        }

        const targetDate = market.targetDate || new Date();

        try {
            // Check prefetched data first for ~200ms savings
            const prefetched = this.getPrefetchedWeather(market.city, targetDate);
            
            let maxPrecipProb: number;
            let source: 'noaa' | 'openweather' = 'noaa';
            
            if (prefetched?.precipProbability !== null && prefetched?.precipProbability !== undefined) {
                // Use prefetched precipitation data
                maxPrecipProb = prefetched.precipProbability;
            } else {
                // Fallback to API call
                const forecast = await this.weatherService.getForecastByCity(market.city);

                // Normalize target date for comparison - use date string comparison
                const targetDateObj = new Date(targetDate);
                targetDateObj.setUTCHours(0, 0, 0, 0);
                const targetDateStr = targetDateObj.toISOString().split('T')[0];

                // Find precipitation probability for target date
                const dayForecasts = forecast.hourly.filter(h => {
                    const hourDate = new Date(h.timestamp);
                    // Use date string comparison to avoid timestamp mismatch issues
                    return hourDate.toISOString().split('T')[0] === targetDateStr;
                });

                if (dayForecasts.length === 0) {
                    return null;
                }

                // Use max precipitation probability for the day
                maxPrecipProb = Math.max(...dayForecasts.map(h => h.probabilityOfPrecipitation));
                source = forecast.source as 'noaa' | 'openweather';
            }

            // Convert to 0-1 probability
            const probability = maxPrecipProb / 100;

            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            const confidence = Math.max(0.3, 0.85 - daysAhead * 0.1);

            return {
                probability,
                forecastValue: maxPrecipProb,
                source,
                confidence,
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Batch analyze multiple markets with prefetch optimization (~200ms savings)
     */
    async analyzeMarkets(markets: ParsedWeatherMarket[]): Promise<TradingOpportunity[]> {
        // Cleanup stale captured opportunities to prevent memory leaks
        this.cleanupStaleCaptures();
        
        const opportunities: TradingOpportunity[] = [];

        // Prefetch weather data for all markets in parallel before analysis
        await this.prefetchWeatherData(markets);

        // Process markets in parallel for faster analysis
        const analysisPromises = markets.map(async (market) => {
            const opportunity = await this.analyzeMarket(market);
            // Return all opportunities including those with action='none'
            // This allows tracking considered/rejected trades in the dashboard
            if (opportunity) {
                return opportunity;
            }
            return null;
        });

        const results = await Promise.all(analysisPromises);
        for (const opp of results) {
            if (opp) opportunities.push(opp);
        }

        // Sort: guaranteed first, then by edge (highest first)
        opportunities.sort((a, b) => {
            // Guaranteed opportunities always come first
            if (a.isGuaranteed && !b.isGuaranteed) return -1;
            if (!a.isGuaranteed && b.isGuaranteed) return 1;
            // If both same category, sort by edge
            return Math.abs(b.edge) - Math.abs(a.edge);
        });

        return opportunities;
    }

    /**
     * Check if forecast indicates a guaranteed outcome
     * Returns null if not guaranteed, otherwise returns the guaranteed probability and sigma
     */
    private isGuaranteedOutcome(
        forecastValue: number | undefined,
        threshold: number | undefined,
        metricType: string,
        comparisonType: string | undefined,
        minThreshold?: number,
        maxThreshold?: number
    ): { probability: number; sigma: number } | null {
        if (forecastValue === undefined) {
            return null;
        }

        // Get uncertainty for this metric type
        // Dynamic uncertainty based on metric type (daysToEvent not available here, use base values)
        let uncertainty: number;
        switch (metricType) {
            case 'temperature_high':
            case 'temperature_low':
            case 'temperature_threshold':
            case 'temperature_range':
                uncertainty = 3.9; // ~day-3 calibrated: 1.5 + 0.8*3
                break;
            case 'precipitation':
                uncertainty = 10; // percentage points
                break;
            default:
                uncertainty = 5; // Generic fallback
        }

        // Handle Range Markets
        if (metricType === 'temperature_range') {
            if (minThreshold === undefined || maxThreshold === undefined) {
                return null;
            }

            // Guaranteed YES if min + sigma < forecast < max - sigma
            // Guaranteed NO if forecast < min - sigma OR forecast > max + sigma

            // Check lower bound distance
            const diffMin = forecastValue - minThreshold;
            const sigmaMin = Math.abs(diffMin) / uncertainty;

            // Check upper bound distance
            const diffMax = forecastValue - maxThreshold;
            const sigmaMax = Math.abs(diffMax) / uncertainty;

            if (forecastValue > minThreshold && forecastValue < maxThreshold) {
                // Inside range. Are we safely inside?
                // We need to be > 3 sigma from min AND > 3 sigma from max
                if (sigmaMin >= config.certaintySigmaThreshold && sigmaMax >= config.certaintySigmaThreshold) {
                    return { probability: 1.0, sigma: Math.min(sigmaMin, sigmaMax) };
                }
            } else {
                // Outside range. Are we safely outside?
                // Either safely below min OR safely above max
                if (forecastValue <= minThreshold && sigmaMin >= config.certaintySigmaThreshold) {
                    return { probability: 0.0, sigma: sigmaMin };
                }
                if (forecastValue >= maxThreshold && sigmaMax >= config.certaintySigmaThreshold) {
                    return { probability: 0.0, sigma: sigmaMax };
                }
            }
            return null;
        }

        // For non-range markets, threshold is required
        if (threshold === undefined) {
            return null;
        }

        // Calculate how many standard deviations the forecast is from threshold
        const diff = forecastValue - threshold;
        const sigma = Math.abs(diff) / uncertainty;

        // Check if beyond certainty threshold (configurable, default 3 std devs)
        if (sigma < config.certaintySigmaThreshold) {
            return null;
        }

        // Determine guaranteed probability based on comparison type
        let probability: number;

        if (comparisonType === 'above') {
            // Market asks: "Will X be above threshold?"
            // If forecast >> threshold: guaranteed YES (1.0)
            // If forecast << threshold: guaranteed NO (0.0)
            probability = diff > 0 ? 1.0 : 0.0;
        } else if (comparisonType === 'below') {
            // Market asks: "Will X be below threshold?"
            // If forecast << threshold: guaranteed YES (1.0)
            // If forecast >> threshold: guaranteed NO (0.0)
            probability = diff < 0 ? 1.0 : 0.0;
        } else {
            // Unknown comparison type, can't determine
            return null;
        }

        return { probability, sigma };
    }

    /**
     * Validate that comparisonType makes sense given the forecast and threshold
     * This is a defensive check to catch parsing bugs where comparisonType is wrong
     * 
     * @returns {isValid: boolean, issue?: string, expectedComparisonType?: string}
     */
    private validateComparisonType(
        comparisonType: string | undefined,
        threshold: number,
        forecastValue: number,
        thresholdUnit: 'F' | 'C' | 'inches' | undefined,
        metricType: string
    ): { isValid: boolean; issue?: string; expectedComparisonType?: string } {
        
        // If comparisonType is undefined, we can't validate
        if (comparisonType === undefined) {
            return {
                isValid: false,
                issue: 'comparisonType is undefined - market parsing may have failed',
                expectedComparisonType: 'above or below'
            };
        }

        // For non-temperature metrics, skip validation
        if (!metricType.includes('temperature')) {
            return { isValid: true };
        }

        // Normalize threshold to Fahrenheit for comparison
        let thresholdF = threshold;
        if (thresholdUnit === 'C') {
            thresholdF = (threshold * 9 / 5) + 32;
        }

        // Calculate how far the forecast is from the threshold
        const diff = forecastValue - thresholdF;
        
        // Determine what the expected comparison type should be based on forecast vs threshold
        // Use a small buffer (±2°F) to account for uncertainty
        let expectedComparisonType: 'above' | 'below';
        if (diff > 2) {
            // Forecast is significantly above threshold
            expectedComparisonType = 'above';
        } else if (diff < -2) {
            // Forecast is significantly below threshold
            expectedComparisonType = 'below';
        } else {
            // Forecast is close to threshold - can't determine, skip validation
            return { isValid: true };
        }

        // Check if actual comparisonType matches expected
        if (comparisonType !== expectedComparisonType) {
            return {
                isValid: false,
                issue: `comparisonType is '${comparisonType}' but forecast (${forecastValue}°F) is ${diff > 0 ? 'above' : 'below'} threshold (${thresholdF}°F)`,
                expectedComparisonType
            };
        }

        return { isValid: true };
    }

    /**
     * Validate that the trading action aligns with forecast vs threshold
     * This is the final safety check before trade execution
     * 
     * @returns {isValid: boolean, issue?: string}
     */
    private validateTradeAction(
        action: TradingOpportunity['action'],
        forecastValue: number | undefined,
        threshold: number | undefined,
        comparisonType: string | undefined,
        metricType: string
    ): { isValid: boolean; issue?: string } {
        
        // Skip validation for non-temperature metrics or if no action
        if (action === 'none' || !metricType.includes('temperature') || forecastValue === undefined || threshold === undefined) {
            return { isValid: true };
        }

        // Determine expected action based on forecast vs threshold
        // Use a small buffer (±2°F) for uncertainty
        const diff = forecastValue - threshold;
        
        let expectedAction: TradingOpportunity['action'];
        
        if (comparisonType === 'above') {
            // Market asks: "Will temp be above threshold?"
            // If forecast > threshold + buffer, expected is YES (buy_yes)
            // If forecast < threshold - buffer, expected is NO (buy_no)
            if (diff > 2) {
                expectedAction = 'buy_yes';
            } else if (diff < -2) {
                expectedAction = 'buy_no';
            } else {
                // Forecast is close to threshold, can't determine
                return { isValid: true };
            }
        } else if (comparisonType === 'below') {
            // Market asks: "Will temp be below threshold?"
            // If forecast < threshold - buffer, expected is YES (buy_yes)
            // If forecast > threshold + buffer, expected is NO (buy_no)
            if (diff < -2) {
                expectedAction = 'buy_yes';
            } else if (diff > 2) {
                expectedAction = 'buy_no';
            } else {
                return { isValid: true };
            }
        } else {
            // Unknown comparison type, skip validation
            return { isValid: true };
        }

        // Check if action matches expected
        if (action !== expectedAction) {
            return {
                isValid: false,
                issue: `Action is '${action}' but forecast (${forecastValue}°F) vs threshold (${threshold}°F) with comparison '${comparisonType}' suggests '${expectedAction}'`
            };
        }

        return { isValid: true };
    }
}
