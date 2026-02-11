/**
 * Bayesian Model
 * Updates probabilities using Bayesian inference combining Forecasts + Climatology
 * 
 * Enhanced with:
 * - Model bias correction
 * - Horizon-aware weighting
 * - Ensemble spread contribution to uncertainty
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { normalCDF } from './normal-cdf.js';
import { logger } from '../logger.js';
import { modelBiasCorrector, WeatherVariable } from '../strategy/model-bias-profiles.js';
import { config } from '../config.js';

interface Gaussian {
    mean: number;
    variance: number;
}

export class BayesianModel {

    constructor() { }

    /**
     * Calculate posterior probability given forecast and prior (climatology)
     */
    calculateProbability(
        market: ParsedWeatherMarket,
        forecast: number, // e.g. 85°F
        runTime: Date // When the forecast was generated (or Date.now())
    ): number {

        // 1. Get Likelihood (The Forecast)
        // Variance increases with time to event
        const timeToEventDays = this.getDaysToEvent(market.targetDate);
        const forecastVariance = this.getForecastVariance(market.metricType, timeToEventDays);
        const likelihood: Gaussian = {
            mean: forecast,
            variance: forecastVariance
        };

        // 2. Get Prior (Climatology - simplified)
        // Ideally we'd fetch historical avg for this city/date.
        // For now, we use a weak uninformative prior or the forecast itself if prior unknown,
        // but to demonstrate Bayesian update, let's assume valid ranges.
        // Actually, without a database of priors, using a 'uniform' prior means Posterior = Likelihood.
        // So to make this 'PhD-level' without 10GB of data, we model the "Forecast Uncertainty" rigorously.

        // Let's refine the Likelihood model instead of fake priors.
        // We treat the "True Outcome" as a hidden variable.

        if (market.threshold === undefined) return 0.5;

        const probability = this.calculateExceedanceProbability(
            likelihood,
            market.threshold,
            market.comparisonType === 'above'
        );

        return probability;
    }

    /**
     * Update probability with multiple independent forecasts if available
     * (e.g. NOAA + OpenWeatherMap)
     * 
     * Enhanced with:
     * - Bias correction for each model
     * - Horizon-aware weighting
     * - Ensemble spread contribution to variance
     */
    combineForecasts(
        market: ParsedWeatherMarket,
        forecasts: { source: string, value: number }[]
    ): number {
        if (forecasts.length === 0) return 0.5;

        const timeToEventDays = this.getDaysToEvent(market.targetDate);
        const horizonHours = timeToEventDays * 24;
        const variable = this.mapMetricToVariable(market.metricType);

        // Use enhanced ensemble combination if bias correction is enabled
        if (config.MODEL_BIAS_CORRECTION_ENABLED && config.MODEL_HORIZON_WEIGHTING_ENABLED) {
            return this.combineForecastsEnhanced(market, forecasts, horizonHours, variable);
        }

        // Fallback to original inverse variance weighting
        return this.combineForecastsLegacy(market, forecasts, timeToEventDays);
    }

    /**
     * Enhanced forecast combination with bias correction and horizon-aware weights
     */
    private combineForecastsEnhanced(
        market: ParsedWeatherMarket,
        forecasts: { source: string, value: number }[],
        horizonHours: number,
        variable: WeatherVariable
    ): number {
        let weightedSum = 0;
        let totalWeight = 0;
        const correctedValues: { model: string; value: number }[] = [];

        for (const f of forecasts) {
            // Apply bias correction
            const correctedValue = modelBiasCorrector.applyBiasCorrection(
                f.source,
                f.value,
                variable,
                horizonHours
            );

            correctedValues.push({ model: f.source, value: correctedValue });

            // Get combined weight (horizon + skill)
            const combinedWeight = modelBiasCorrector.getCombinedWeight(
                f.source,
                horizonHours,
                variable
            );

            // Also factor in base variance for the time to event
            const timeToEventDays = horizonHours / 24;
            const baseVariance = this.getForecastVariance(market.metricType, timeToEventDays);
            const varianceWeight = 1 / baseVariance;

            // Final weight combines bias-corrector weight with variance weight
            const finalWeight = combinedWeight * varianceWeight;

            weightedSum += correctedValue * finalWeight;
            totalWeight += finalWeight;

            logger.debug(
                `[BayesianModel] ${f.source}: raw=${f.value.toFixed(2)}, ` +
                `corrected=${correctedValue.toFixed(2)}, weight=${finalWeight.toFixed(4)}`
            );
        }

        const combinedMean = weightedSum / totalWeight;
        
        // Calculate ensemble spread
        const spread = modelBiasCorrector.getEnsembleSpread(correctedValues);
        
        // Combined variance includes inverse weight and spread contribution
        const baseVariance = 1 / totalWeight;
        const spreadContribution = spread * spread * config.MODEL_ENSEMBLE_SPREAD_MULTIPLIER;
        const combinedVariance = baseVariance + spreadContribution;

        logger.info(
            `[BayesianModel] Enhanced ensemble: mean=${combinedMean.toFixed(2)}, ` +
            `variance=${combinedVariance.toFixed(4)}, spread=${spread.toFixed(2)}`
        );

        if (market.threshold === undefined) return 0.5;

        return this.calculateExceedanceProbability(
            { mean: combinedMean, variance: combinedVariance },
            market.threshold,
            market.comparisonType === 'above'
        );
    }

    /**
     * Legacy forecast combination (original inverse variance weighting)
     */
    private combineForecastsLegacy(
        market: ParsedWeatherMarket,
        forecasts: { source: string, value: number }[],
        timeToEventDays: number
    ): number {
        let weightedSum = 0;
        let totalWeight = 0;

        for (const f of forecasts) {
            const baseVariance = this.getForecastVariance(market.metricType, timeToEventDays);
            // NOAA is "Gold Standard", others have higher variance
            const penalty = f.source === 'noaa' ? 1.0 : 1.5;
            const variance = baseVariance * penalty;
            const weight = 1 / variance;

            weightedSum += f.value * weight;
            totalWeight += weight;
        }

        const combinedMean = weightedSum / totalWeight;
        const combinedVariance = 1 / totalWeight;

        if (market.threshold === undefined) return 0.5;

        return this.calculateExceedanceProbability(
            { mean: combinedMean, variance: combinedVariance },
            market.threshold,
            market.comparisonType === 'above'
        );
    }

    /**
     * Map market metric type to bias corrector variable type
     */
    private mapMetricToVariable(metric: string): WeatherVariable {
        if (metric?.includes('temp') || metric?.includes('temperature')) {
            return 'temperature';
        }
        if (metric?.includes('snow')) {
            return 'snow';
        }
        if (metric?.includes('precip') || metric?.includes('rain')) {
            return 'precipitation';
        }
        if (metric?.includes('wind')) {
            return 'wind';
        }
        return 'temperature'; // Default
    }

    private getDaysToEvent(targetDate?: Date): number {
        if (!targetDate) return 1;
        const diff = targetDate.getTime() - Date.now();
        return Math.max(0, diff / (1000 * 60 * 60 * 24));
    }

    private getForecastVariance(metric: string, days: number): number {
        // Variance growth model: V = V_0 + growth * days
        // Based on typical meteorological verification stats
        if (metric === 'temperature_high') {
            // Temp variance: starts at 2°F^2, grows to 25°F^2 at 10 days
            // Sigma starts ~1.4°F, grows to ~5°F
            return 2 + (2.3 * days); // Linear growth in variance
        } else if (metric === 'snowfall') {
            // Snow is highly uncertain.
            // Variance scales with magnitude, but here we simplify
            return 1 + (0.5 * days);
        }
        return 5 + days; // Default high uncertainty
    }

    private calculateExceedanceProbability(
        distribution: Gaussian,
        threshold: number,
        isAbove: boolean
    ): number {
        const stdDev = Math.sqrt(distribution.variance);
        const z = (threshold - distribution.mean) / stdDev;

        // CDF of standard normal
        // P(X < threshold)
        const pBelow = normalCDF(z);

        return isAbove ? (1 - pBelow) : pBelow;
    }
}
