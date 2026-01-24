/**
 * Opportunity Detector
 * Compares weather forecasts to market prices to find trading opportunities
 */

import { WeatherService } from '../weather/index.js';
import { ParsedWeatherMarket, TradingOpportunity } from '../polymarket/types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class OpportunityDetector {
    private weatherService: WeatherService;

    constructor() {
        this.weatherService = new WeatherService();
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

            switch (market.metricType) {
                case 'temperature_high':
                case 'temperature_threshold':
                    const result = await this.analyzeTemperatureMarket(market);
                    if (result) {
                        forecastProbability = result.probability;
                        forecastValue = result.forecastValue;
                        forecastValueUnit = '°F';
                        weatherDataSource = result.source;
                        confidence = result.confidence;
                    }
                    break;

                case 'temperature_low':
                    const lowResult = await this.analyzeTemperatureLowMarket(market);
                    if (lowResult) {
                        forecastProbability = lowResult.probability;
                        forecastValue = lowResult.forecastValue;
                        forecastValueUnit = '°F';
                        weatherDataSource = lowResult.source;
                        confidence = lowResult.confidence;
                    }
                    break;

                case 'snowfall':
                    const snowResult = await this.analyzeSnowfallMarket(market);
                    if (snowResult) {
                        forecastProbability = snowResult.probability;
                        forecastValue = snowResult.forecastValue;
                        forecastValueUnit = 'inches';
                        weatherDataSource = snowResult.source;
                        confidence = snowResult.confidence;
                    }
                    break;

                case 'precipitation':
                    const precipResult = await this.analyzePrecipitationMarket(market);
                    if (precipResult) {
                        forecastProbability = precipResult.probability;
                        forecastValue = precipResult.forecastValue;
                        forecastValueUnit = '%';
                        weatherDataSource = precipResult.source;
                        confidence = precipResult.confidence;
                    }
                    break;

                default:
                    return null;
            }

            if (forecastProbability === null) {
                return null;
            }

            // Market implied probability (YES price = probability of YES outcome)
            const marketProbability = market.yesPrice;

            // Edge calculation: positive = market underprices YES, negative = market overprices YES
            const edge = forecastProbability - marketProbability;
            const absEdge = Math.abs(edge);

            // Determine action based on edge
            let action: TradingOpportunity['action'] = 'none';
            let reason = '';

            if (absEdge >= config.minEdgeThreshold) {
                if (edge > 0) {
                    // Forecast says higher probability than market -> buy YES
                    action = 'buy_yes';
                    reason = `Forecast (${(forecastProbability * 100).toFixed(1)}%) higher than market (${(marketProbability * 100).toFixed(1)}%)`;
                } else {
                    // Forecast says lower probability than market -> buy NO
                    action = 'buy_no';
                    reason = `Forecast (${(forecastProbability * 100).toFixed(1)}%) lower than market (${(marketProbability * 100).toFixed(1)}%)`;
                }
            } else {
                reason = `Edge ${(absEdge * 100).toFixed(1)}% below threshold ${(config.minEdgeThreshold * 100).toFixed(0)}%`;
            }

            return {
                market,
                forecastProbability,
                marketProbability,
                edge,
                action,
                confidence,
                reason,
                weatherDataSource,
                forecastValue,
                forecastValueUnit,
            };
        } catch (error) {
            logger.error(`Failed to analyze market: ${market.market.question}`, {
                error: (error as Error).message,
            });
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

            if (market.comparisonType === 'above') {
                // Probability that temp will be ABOVE threshold
                probability = this.weatherService.calculateTempExceedsProbability(
                    forecastHigh,
                    market.threshold,
                    uncertainty
                );
            } else {
                // Probability that temp will be BELOW threshold
                probability = 1 - this.weatherService.calculateTempExceedsProbability(
                    forecastHigh,
                    market.threshold,
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

            if (market.comparisonType === 'below') {
                probability = 1 - this.weatherService.calculateTempExceedsProbability(
                    forecastLow,
                    market.threshold,
                    uncertainty
                );
            } else {
                probability = this.weatherService.calculateTempExceedsProbability(
                    forecastLow,
                    market.threshold,
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
     * Analyze a snowfall market
     */
    private async analyzeSnowfallMarket(market: ParsedWeatherMarket): Promise<{
        probability: number;
        forecastValue: number;
        source: 'noaa' | 'openweather';
        confidence: number;
    } | null> {
        if (!market.city) {
            return null;
        }

        const threshold = market.threshold || 0.1;
        const targetDate = market.targetDate || new Date();

        // For snowfall, get range from target date to end of day or weekend
        const startDate = new Date(targetDate);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(targetDate);
        endDate.setHours(23, 59, 59, 999);

        try {
            const forecastSnow = await this.weatherService.getExpectedSnowfall(
                market.city,
                startDate,
                endDate
            );

            const uncertainty = 2; // Snow forecast uncertainty in inches
            let probability: number;

            if (market.comparisonType === 'above') {
                probability = this.weatherService.calculateSnowExceedsProbability(
                    forecastSnow,
                    threshold,
                    uncertainty
                );
            } else {
                probability = 1 - this.weatherService.calculateSnowExceedsProbability(
                    forecastSnow,
                    threshold,
                    uncertainty
                );
            }

            // Snow forecasts are less reliable
            const daysAhead = (targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            const confidence = Math.max(0.2, 0.7 - daysAhead * 0.15);

            return {
                probability,
                forecastValue: forecastSnow,
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
            const targetDateStr = targetDate.toISOString().split('T')[0];

            // Find precipitation probability for target date
            const dayForecasts = forecast.hourly.filter(h =>
                h.timestamp.toISOString().split('T')[0] === targetDateStr
            );

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
                source: forecast.source,
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

        for (const market of markets) {
            const opportunity = await this.analyzeMarket(market);
            if (opportunity && opportunity.action !== 'none') {
                opportunities.push(opportunity);
            }
        }

        // Sort by edge (highest first)
        opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

        return opportunities;
    }
}
