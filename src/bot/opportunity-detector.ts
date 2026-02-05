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
    
    // Track rejection reasons for debugging
    private rejectionStats: RejectionStats = {
        marketCaughtUp: 0,
        alreadyCaptured: 0,
        forecastChangeBelowThreshold: 0,
        totalChecked: 0,
    };
    private lastRejectionLogTime: number = 0;

    constructor(store?: DataStore) {
        this.weatherService = new WeatherService();
        this.store = store ?? null;
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
     * Log rejection reasons periodically (every 5 minutes)
     */
    private logRejectionStats(): void {
        const now = Date.now();
        if (now - this.lastRejectionLogTime > 5 * 60 * 1000) {
            logger.info('📊 Opportunity Rejection Stats (last 5 min)', {
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

            // Edge calculation: positive = market underprices YES, negative = market overprices YES
            const edge = finalProbability - marketProbability;
            const absEdge = Math.abs(edge);

            // Determine action based on edge
            let action: TradingOpportunity['action'] = 'none';
            let reason = '';

            // For guaranteed outcomes, always trade if there's meaningful edge
            // For regular opportunities, use the configured threshold
            const effectiveThreshold = isGuaranteed ? 0.05 : config.minEdgeThreshold;

            if (absEdge >= effectiveThreshold) {
                if (edge > 0) {
                    // Forecast says higher probability than market -> buy YES
                    action = 'buy_yes';
                    reason = isGuaranteed
                        ? `🎯 GUARANTEED: ${certaintySigma?.toFixed(1)}σ confidence`
                        : `Forecast higher than market by ${(absEdge * 100).toFixed(1)}%`;
                } else {
                    // Forecast says lower probability than market -> buy NO
                    action = 'buy_no';
                    reason = isGuaranteed
                        ? `🎯 GUARANTEED: ${certaintySigma?.toFixed(1)}σ confidence`
                        : `Forecast lower than market by ${(absEdge * 100).toFixed(1)}%`;
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
            const uncertainty = 3; // Typical forecast uncertainty in °F

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

            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
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
     * Analyze a temperature high market
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
            const forecastHigh = await this.weatherService.getExpectedHigh(market.city, targetDate);

            if (forecastHigh === null) {
                logger.warn(`No temperature forecast available for ${market.city}`);
                return null;
            }

            // Calculate probability based on comparison type
            let probability: number;
            const uncertainty = 3; // Typical forecast uncertainty in °F

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
            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
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
            const forecastLow = await this.weatherService.getExpectedLow(market.city, targetDate);

            if (forecastLow === null) {
                return null;
            }

            let probability: number;
            const uncertainty = 3;

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

            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
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
            const forecast = await this.weatherService.getForecastByCity(market.city);

            // Normalize target date for comparison
            const targetDateObj = new Date(targetDate);
            targetDateObj.setUTCHours(0, 0, 0, 0);

            // Find precipitation probability for target date
            const dayForecasts = forecast.hourly.filter(h => {
                const hourDate = new Date(h.timestamp);
                hourDate.setUTCHours(0, 0, 0, 0);
                return hourDate.getTime() === targetDateObj.getTime();
            });

            if (dayForecasts.length === 0) {
                return null;
            }

            // Use max precipitation probability for the day
            const maxPrecipProb = Math.max(...dayForecasts.map(h => h.probabilityOfPrecipitation));

            // Convert to 0-1 probability
            const probability = maxPrecipProb / 100;

            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            const confidence = Math.max(0.3, 0.85 - daysAhead * 0.1);

            return {
                probability,
                forecastValue: maxPrecipProb,
                source: forecast.source as 'noaa' | 'openweather',
                confidence,
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Batch analyze multiple markets
     */
    async analyzeMarkets(markets: ParsedWeatherMarket[]): Promise<TradingOpportunity[]> {
        const opportunities: TradingOpportunity[] = [];

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
        let uncertainty: number;
        switch (metricType) {
            case 'temperature_high':
            case 'temperature_low':
            case 'temperature_threshold':
            case 'temperature_range':
                uncertainty = 3; // °F
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
}
