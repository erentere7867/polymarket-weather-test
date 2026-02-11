/**
 * Model Bias Profiles
 * Quantifies systematic biases and skill for each weather model
 * 
 * Based on meteorological research and verification statistics:
 * - HRRR: High-resolution rapid refresh, best for 0-18h, convective bias in summer
 * - RAP: Rapid refresh, good for 0-6h, tends to smooth extremes
 * - GFS: Global forecast system, good at 72h+, cold bias in winter
 * - ECMWF: European model, best overall skill, lower variance
 */

import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Supported weather models
 */
export type SupportedModel = 'HRRR' | 'RAP' | 'GFS' | 'ECMWF';

/**
 * Variable types for skill assessment
 */
export type WeatherVariable = 'temperature' | 'precipitation' | 'snow' | 'wind';

/**
 * Bias profile for a weather model
 */
export interface ModelBiasProfile {
    model: SupportedModel;
    
    // Temperature biases (°F) - positive = warm bias
    tempBias: {
        shortRange: number;  // 0-24h
        mediumRange: number; // 24-72h  
        longRange: number;   // 72h+
    };
    
    // Precipitation biases (fraction) - positive = over-predicts
    precipBias: {
        shortRange: number;
        mediumRange: number;
        longRange: number;
    };
    
    // Model skill by variable (0-1, higher = better)
    skillByVariable: {
        temperature: number;
        precipitation: number;
        snow: number;
        wind: number;
    };
    
    // Horizon-dependent weight decay
    weightDecay: {
        optimalHours: number;   // Peak performance horizon
        decayRate: number;      // How fast skill decays per hour from optimal
    };
    
    // Known systematic biases for logging/awareness
    knownBiases: string[];
}

/**
 * Known model characteristics based on meteorological research
 */
export const MODEL_PROFILES: Record<SupportedModel, ModelBiasProfile> = {
    HRRR: {
        model: 'HRRR',
        tempBias: { shortRange: 0.2, mediumRange: 0.5, longRange: 1.0 },
        precipBias: { shortRange: 0.05, mediumRange: 0.1, longRange: 0.2 },
        skillByVariable: { temperature: 0.9, precipitation: 0.85, snow: 0.8, wind: 0.85 },
        weightDecay: { optimalHours: 6, decayRate: 0.02 },
        knownBiases: ['convective bias in summer', 'warm bias at night']
    },
    RAP: {
        model: 'RAP',
        tempBias: { shortRange: 0.3, mediumRange: 0.6, longRange: 1.2 },
        precipBias: { shortRange: 0.1, mediumRange: 0.15, longRange: 0.25 },
        skillByVariable: { temperature: 0.85, precipitation: 0.8, snow: 0.75, wind: 0.8 },
        weightDecay: { optimalHours: 3, decayRate: 0.03 },
        knownBiases: ['smoothing bias', 'underestimates extremes']
    },
    GFS: {
        model: 'GFS',
        tempBias: { shortRange: 0.5, mediumRange: 0.8, longRange: 1.5 },
        precipBias: { shortRange: 0.15, mediumRange: 0.2, longRange: 0.3 },
        skillByVariable: { temperature: 0.8, precipitation: 0.75, snow: 0.7, wind: 0.75 },
        weightDecay: { optimalHours: 72, decayRate: 0.01 },
        knownBiases: ['cold bias in winter', 'over-predicts precipitation']
    },
    ECMWF: {
        model: 'ECMWF',
        tempBias: { shortRange: 0.2, mediumRange: 0.4, longRange: 0.8 },
        precipBias: { shortRange: 0.05, mediumRange: 0.1, longRange: 0.15 },
        skillByVariable: { temperature: 0.92, precipitation: 0.88, snow: 0.85, wind: 0.85 },
        weightDecay: { optimalHours: 120, decayRate: 0.008 },
        knownBiases: ['lower variance overall', 'delayed with extreme events']
    }
};

/**
 * Result of bias correction with metadata
 */
export interface BiasCorrectionResult {
    originalValue: number;
    correctedValue: number;
    biasApplied: number;
    model: string;
    variable: string;
    horizonHours: number;
}

/**
 * Weighted forecast for ensemble combination
 */
export interface WeightedForecast {
    model: string;
    value: number;
    correctedValue: number;
    weight: number;
    horizonWeight: number;
    skillWeight: number;
}

/**
 * Model Bias Corrector
 * Applies bias corrections and calculates horizon-aware weights
 */
export class ModelBiasCorrector {
    private correctionLog: BiasCorrectionResult[] = [];
    private maxLogSize: number = 100;

    constructor() {
        logger.info('[ModelBiasCorrector] Initialized with profiles for:', Object.keys(MODEL_PROFILES).join(', '));
    }

    /**
     * Get the bias profile for a model
     */
    getProfile(model: string): ModelBiasProfile | null {
        const upperModel = model.toUpperCase() as SupportedModel;
        return MODEL_PROFILES[upperModel] || null;
    }

    /**
     * Get horizon range category
     */
    private getHorizonRange(horizonHours: number): 'shortRange' | 'mediumRange' | 'longRange' {
        if (horizonHours <= 24) return 'shortRange';
        if (horizonHours <= 72) return 'mediumRange';
        return 'longRange';
    }

    /**
     * Apply bias correction to a raw forecast value
     * 
     * @param model - Model name (HRRR, RAP, GFS, ECMWF)
     * @param value - Raw forecast value
     * @param variable - Variable type (temperature, precipitation, etc.)
     * @param horizonHours - Hours until the forecast time
     * @returns Bias-corrected value
     */
    applyBiasCorrection(
        model: string,
        value: number,
        variable: WeatherVariable,
        horizonHours: number
    ): number {
        // Check if bias correction is enabled
        if (!config.MODEL_BIAS_CORRECTION_ENABLED) {
            return value;
        }

        const profile = this.getProfile(model);
        if (!profile) {
            logger.debug(`[ModelBiasCorrector] No profile for model ${model}, returning raw value`);
            return value;
        }

        const horizonRange = this.getHorizonRange(horizonHours);
        let bias = 0;

        // Get appropriate bias based on variable type
        if (variable === 'temperature') {
            bias = profile.tempBias[horizonRange];
        } else if (variable === 'precipitation' || variable === 'snow') {
            // For precipitation, bias is multiplicative
            const precipBias = profile.precipBias[horizonRange];
            const correctedValue = value / (1 + precipBias);
            
            this.logCorrection({
                originalValue: value,
                correctedValue,
                biasApplied: precipBias,
                model,
                variable,
                horizonHours
            });
            
            return correctedValue;
        }
        // Wind doesn't have explicit bias correction, use raw value

        // For temperature, subtract bias (positive bias = model predicts too warm)
        const correctedValue = value - bias;

        this.logCorrection({
            originalValue: value,
            correctedValue,
            biasApplied: bias,
            model,
            variable,
            horizonHours
        });

        logger.debug(
            `[ModelBiasCorrector] ${model} ${variable} at ${horizonHours}h: ` +
            `${value.toFixed(2)} → ${correctedValue.toFixed(2)} (bias: ${bias.toFixed(3)})`
        );

        return correctedValue;
    }

    /**
     * Get horizon-aware weight for a model
     * Uses Gaussian decay from optimal horizon
     * 
     * @param model - Model name
     * @param horizonHours - Hours until the forecast time
     * @returns Weight between 0 and 1
     */
    getHorizonWeight(model: string, horizonHours: number): number {
        if (!config.MODEL_HORIZON_WEIGHTING_ENABLED) {
            return 1.0;
        }

        const profile = this.getProfile(model);
        if (!profile) {
            return 0.5; // Default weight for unknown models
        }

        const { optimalHours, decayRate } = profile.weightDecay;
        
        // Gaussian-like decay from optimal
        // Weight = exp(-decayRate * |horizon - optimal|^2 / optimal)
        const distance = Math.abs(horizonHours - optimalHours);
        const normalizedDistance = distance / Math.max(optimalHours, 1);
        const weight = Math.exp(-decayRate * normalizedDistance * normalizedDistance * 100);

        // Ensure minimum weight of 0.1
        return Math.max(0.1, Math.min(1.0, weight));
    }

    /**
     * Get skill weight for a variable
     * 
     * @param model - Model name
     * @param variable - Variable type
     * @returns Skill weight between 0 and 1
     */
    getSkillWeight(model: string, variable: WeatherVariable): number {
        const profile = this.getProfile(model);
        if (!profile) {
            return 0.5;
        }

        return profile.skillByVariable[variable] || 0.5;
    }

    /**
     * Get combined weight including horizon and variable skill
     * 
     * @param model - Model name
     * @param horizonHours - Hours until the forecast time
     * @param variable - Variable type
     * @returns Combined weight between 0 and 1
     */
    getCombinedWeight(model: string, horizonHours: number, variable: WeatherVariable): number {
        const horizonWeight = this.getHorizonWeight(model, horizonHours);
        const skillWeight = this.getSkillWeight(model, variable);
        
        // Geometric mean of horizon and skill weights
        const combinedWeight = Math.sqrt(horizonWeight * skillWeight);

        logger.debug(
            `[ModelBiasCorrector] ${model} combined weight: ` +
            `horizon=${horizonWeight.toFixed(3)}, skill=${skillWeight.toFixed(3)}, ` +
            `combined=${combinedWeight.toFixed(3)}`
        );

        return combinedWeight;
    }

    /**
     * Get ensemble spread (uncertainty proxy) from multiple model forecasts
     * Higher spread = more uncertainty
     * 
     * @param forecasts - Array of model forecasts with values
     * @returns Standard deviation of the ensemble
     */
    getEnsembleSpread(forecasts: { model: string; value: number }[]): number {
        if (forecasts.length < 2) {
            return 0;
        }

        const values = forecasts.map(f => f.value);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        
        return Math.sqrt(variance);
    }

    /**
     * Get weighted ensemble forecast combining multiple models
     * 
     * @param forecasts - Array of raw model forecasts
     * @param variable - Variable type
     * @param horizonHours - Hours until forecast time
     * @returns Weighted ensemble result
     */
    getWeightedEnsemble(
        forecasts: { model: string; value: number }[],
        variable: WeatherVariable,
        horizonHours: number
    ): {
        mean: number;
        variance: number;
        spread: number;
        weights: WeightedForecast[];
    } {
        if (forecasts.length === 0) {
            return { mean: 0, variance: 1, spread: 0, weights: [] };
        }

        const weightedForecasts: WeightedForecast[] = [];
        let weightedSum = 0;
        let totalWeight = 0;

        for (const forecast of forecasts) {
            // Apply bias correction
            const correctedValue = this.applyBiasCorrection(
                forecast.model,
                forecast.value,
                variable,
                horizonHours
            );

            // Get combined weight
            const combinedWeight = this.getCombinedWeight(
                forecast.model,
                horizonHours,
                variable
            );

            const horizonWeight = this.getHorizonWeight(forecast.model, horizonHours);
            const skillWeight = this.getSkillWeight(forecast.model, variable);

            const weighted: WeightedForecast = {
                model: forecast.model,
                value: forecast.value,
                correctedValue,
                weight: combinedWeight,
                horizonWeight,
                skillWeight
            };

            weightedForecasts.push(weighted);
            weightedSum += correctedValue * combinedWeight;
            totalWeight += combinedWeight;
        }

        const mean = totalWeight > 0 ? weightedSum / totalWeight : 0;
        
        // Calculate ensemble spread
        const spread = this.getEnsembleSpread(
            weightedForecasts.map(wf => ({ model: wf.model, value: wf.correctedValue }))
        );

        // Variance includes ensemble spread contribution
        const baseVariance = totalWeight > 0 ? 1 / totalWeight : 1;
        const spreadContribution = spread * spread * (config.MODEL_ENSEMBLE_SPREAD_MULTIPLIER || 0.5);
        const variance = baseVariance + spreadContribution;

        logger.info(
            `[ModelBiasCorrector] Ensemble: mean=${mean.toFixed(2)}, ` +
            `variance=${variance.toFixed(4)}, spread=${spread.toFixed(2)}, ` +
            `models=${forecasts.length}`
        );

        return { mean, variance, spread, weights: weightedForecasts };
    }

    /**
     * Log a bias correction for debugging/analysis
     */
    private logCorrection(result: BiasCorrectionResult): void {
        this.correctionLog.push(result);
        
        // Trim log if too large
        if (this.correctionLog.length > this.maxLogSize) {
            this.correctionLog.shift();
        }
    }

    /**
     * Get recent correction log
     */
    getCorrectionLog(): BiasCorrectionResult[] {
        return [...this.correctionLog];
    }

    /**
     * Clear correction log
     */
    clearLog(): void {
        this.correctionLog = [];
    }

    /**
     * Get known biases for a model
     */
    getKnownBiases(model: string): string[] {
        const profile = this.getProfile(model);
        return profile?.knownBiases || [];
    }

    /**
     * Check if a model has a specific known bias
     */
    hasKnownBias(model: string, biasPattern: string): boolean {
        const knownBiases = this.getKnownBiases(model);
        return knownBiases.some(bias => 
            bias.toLowerCase().includes(biasPattern.toLowerCase())
        );
    }
}

// Export singleton instance for convenience
export const modelBiasCorrector = new ModelBiasCorrector();

export default ModelBiasCorrector;
