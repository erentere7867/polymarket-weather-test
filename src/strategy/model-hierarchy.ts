/**
 * Model Hierarchy Configuration
 * Defines model roles (primary, secondary, regime) per region
 * 
 * HARD RULES:
 * - US: HRRR (primary) → RAP (secondary) → GFS (regime)
 * - Europe: ECMWF (primary) → GFS (secondary)
 * - Lower-tier models may block/down-weight trades but NEVER initiate them
 */

import { ModelType } from '../weather/types.js';
import { logger } from '../logger.js';
import { ModelBiasCorrector, WeatherVariable, WeightedForecast } from './model-bias-profiles.js';

/**
 * Role a model plays in the trading decision
 */
export type ModelRole = 'primary' | 'secondary' | 'regime';

/**
 * Configuration for model hierarchy in a region
 */
export interface ModelHierarchyConfig {
    region: 'US' | 'EUROPE' | 'GLOBAL';
    primary: ModelType;      // Execution model - initiates trades
    secondary: ModelType;    // Filter model - confirms/blocks
    regime?: ModelType;      // Context only - synoptic background
}

/**
 * US Model Hierarchy
 * HRRR is high-resolution, runs hourly - primary execution
 * RAP is coarser but fast - secondary confirmation
 * GFS is global, lower resolution - regime context only
 */
export const US_HIERARCHY: ModelHierarchyConfig = {
    region: 'US',
    primary: 'HRRR',
    secondary: 'RAP',
    regime: 'GFS',
};

/**
 * Europe Model Hierarchy
 * ECMWF is the gold standard for Europe - primary execution
 * GFS provides secondary confirmation
 */
export const EUROPE_HIERARCHY: ModelHierarchyConfig = {
    region: 'EUROPE',
    primary: 'ECMWF',
    secondary: 'GFS',
};

/**
 * Global fallback (non-US, non-Europe)
 * Uses GFS as primary since it's the only global model
 */
export const GLOBAL_HIERARCHY: ModelHierarchyConfig = {
    region: 'GLOBAL',
    primary: 'GFS',
    secondary: 'GFS', // No secondary available
};

/**
 * Cities and their regions for hierarchy selection
 */
const CITY_REGIONS: Record<string, 'US' | 'EUROPE' | 'GLOBAL'> = {
    // US Cities (CONUS) - use HRRR
    // Include common name variants from WeatherScanner + file ingestion
    'new york': 'US',
    'new york city': 'US',
    'nyc': 'US',
    'los angeles': 'US',
    'chicago': 'US',
    'miami': 'US',
    'houston': 'US',
    'phoenix': 'US',
    'denver': 'US',
    'seattle': 'US',
    'washington dc': 'US',
    'washington': 'US',
    'boston': 'US',
    'atlanta': 'US',
    'san francisco': 'US',
    'dallas': 'US',
    'las vegas': 'US',
    'san diego': 'US',
    'san antonio': 'US',
    'philadelphia': 'US',
    'san jose': 'US',

    // European Cities - use ECMWF
    'london': 'EUROPE',
    'paris': 'EUROPE',
    'berlin': 'EUROPE',
    'madrid': 'EUROPE',
    'rome': 'EUROPE',
    'amsterdam': 'EUROPE',
    'brussels': 'EUROPE',
    'vienna': 'EUROPE',
    'zurich': 'EUROPE',
    'stockholm': 'EUROPE',
    'ankara': 'EUROPE',
    'seoul': 'EUROPE',

    // Global Cities - use GFS (including Canadian cities - HRRR coverage is poor outside CONUS)
    'tokyo': 'GLOBAL',
    'sydney': 'GLOBAL',
    'hong kong': 'GLOBAL',
    'singapore': 'GLOBAL',
    'dubai': 'GLOBAL',
    'mumbai': 'GLOBAL',
    'são paulo': 'GLOBAL',
    'buenos aires': 'GLOBAL',
    'mexico city': 'GLOBAL',
    'toronto': 'GLOBAL', // HRRR doesn't cover Toronto well, use GFS
    'vancouver': 'GLOBAL', // Outside HRRR domain, use GFS
};

/**
 * Model Hierarchy Manager
 * Determines which models to use for each city and validates model roles
 */
export class ModelHierarchy {
    private hierarchies: Map<string, ModelHierarchyConfig> = new Map();
    private biasCorrector: ModelBiasCorrector;

    constructor() {
        this.biasCorrector = new ModelBiasCorrector();
        // Pre-populate city hierarchies
        for (const [city, region] of Object.entries(CITY_REGIONS)) {
            const hierarchy = this.getHierarchyForRegion(region);
            this.hierarchies.set(city.toLowerCase(), hierarchy);
        }
        logger.info(`[ModelHierarchy] Initialized with ${this.hierarchies.size} city configurations`);
    }

    /**
     * Get hierarchy config for a region
     */
    private getHierarchyForRegion(region: 'US' | 'EUROPE' | 'GLOBAL'): ModelHierarchyConfig {
        switch (region) {
            case 'US': return US_HIERARCHY;
            case 'EUROPE': return EUROPE_HIERARCHY;
            case 'GLOBAL': return GLOBAL_HIERARCHY;
        }
    }

    /**
     * Get the hierarchy for a city
     */
    getHierarchy(cityId: string): ModelHierarchyConfig {
        // Normalize: convert underscores to spaces to match map key format
        const withSpaces = cityId.toLowerCase().trim().replace(/_/g, ' ');
        
        // Try exact match first
        const exact = this.hierarchies.get(withSpaces);
        if (exact) return exact;
        
        // Try stripping common suffixes like 'city'
        const stripped = withSpaces.replace(/\s+city$/, '');
        const strippedMatch = this.hierarchies.get(stripped);
        if (strippedMatch) return strippedMatch;
        
        // Try prefix match (e.g., 'washington dc' starts with 'washington')
        for (const [key, config] of this.hierarchies) {
            if (withSpaces.startsWith(key) || key.startsWith(withSpaces)) {
                return config;
            }
        }
        
        return GLOBAL_HIERARCHY;
    }

    /**
     * Get the role of a model for a city
     */
    getModelRole(cityId: string, model: ModelType): ModelRole | null {
        const hierarchy = this.getHierarchy(cityId);

        if (model === hierarchy.primary) return 'primary';
        if (model === hierarchy.secondary) return 'secondary';
        if (model === hierarchy.regime) return 'regime';

        return null;
    }

    /**
     * Check if a model can initiate trades for a city
     * CRITICAL: Only primary models can initiate trades
     */
    canInitiateTrade(cityId: string, model: ModelType): boolean {
        const role = this.getModelRole(cityId, model);
        return role === 'primary';
    }

    /**
     * Check if a model can block/filter trades for a city
     * Secondary and regime models can block, but not initiate
     */
    canBlockTrade(cityId: string, model: ModelType): boolean {
        const role = this.getModelRole(cityId, model);
        return role === 'secondary' || role === 'regime';
    }

    /**
     * Get the primary model for a city
     */
    getPrimaryModel(cityId: string): ModelType {
        return this.getHierarchy(cityId).primary;
    }

    /**
     * Get the secondary model for a city
     */
    getSecondaryModel(cityId: string): ModelType {
        return this.getHierarchy(cityId).secondary;
    }

    /**
     * Get the regime model for a city (if any)
     */
    getRegimeModel(cityId: string): ModelType | undefined {
        return this.getHierarchy(cityId).regime;
    }

    /**
     * Get the optimal model for a city based on forecast horizon
     * Horizon-based model selection for best accuracy:
     * - 0-18h: HRRR (US), ECMWF (Europe) - highest resolution short-range
     * - 18-48h: RAP (US), ECMWF (Europe) - medium range
     * - 48h+: GFS (all regions) - global coverage for longer range
     */
    getOptimalModel(cityId: string, horizonHours: number): ModelType {
        const region = this.getRegion(cityId);
        
        // Short range (0-18h): highest resolution models
        if (horizonHours <= 18) {
            if (region === 'US') return 'HRRR';
            if (region === 'EUROPE') return 'ECMWF';
            return 'GFS'; // Global fallback
        }
        
        // Medium range (18-48h): RAP for US, ECMWF for Europe
        if (horizonHours <= 48) {
            if (region === 'US') return 'RAP';
            if (region === 'EUROPE') return 'ECMWF';
            return 'GFS'; // Global fallback
        }
        
        // Long range (48h+): GFS for all regions (global coverage)
        return 'GFS';
    }

    /**
     * Get region for a city
     */
    getRegion(cityId: string): 'US' | 'EUROPE' | 'GLOBAL' {
        const normalized = cityId.toLowerCase().trim().replace(/_/g, ' ');
        return CITY_REGIONS[normalized] || 'GLOBAL';
    }

    /**
     * Get all cities in a region
     */
    getCitiesInRegion(region: 'US' | 'EUROPE' | 'GLOBAL'): string[] {
        return Object.entries(CITY_REGIONS)
            .filter(([_, r]) => r === region)
            .map(([city, _]) => city);
    }

    /**
     * Add or update a city's region
     */
    setCity(cityId: string, region: 'US' | 'EUROPE' | 'GLOBAL'): void {
        const normalized = cityId.toLowerCase().trim().replace(/_/g, ' ');
        CITY_REGIONS[normalized] = region;
        this.hierarchies.set(normalized, this.getHierarchyForRegion(region));
        logger.info(`[ModelHierarchy] Set ${cityId} to region ${region}`);
    }

    /**
     * Get dynamic weight for a model based on horizon and variable
     * Combines role-based weighting with bias corrector's horizon/skill weights
     * 
     * @param cityId - City identifier
     * @param model - Model type
     * @param horizonHours - Hours until forecast time
     * @param variable - Weather variable type
     * @returns Combined dynamic weight
     */
    getDynamicWeight(
        cityId: string,
        model: ModelType,
        horizonHours: number,
        variable: WeatherVariable = 'temperature'
    ): number {
        const role = this.getModelRole(cityId, model);
        
        // Base role weights: primary=1.0, secondary=0.6, regime=0.3
        let roleWeight = 0.3;
        if (role === 'primary') roleWeight = 1.0;
        else if (role === 'secondary') roleWeight = 0.6;
        
        // Get horizon and skill weights from bias corrector
        const combinedWeight = this.biasCorrector.getCombinedWeight(model, horizonHours, variable);
        
        // Final weight is product of role weight and combined bias weight
        const dynamicWeight = roleWeight * combinedWeight;
        
        logger.debug(
            `[ModelHierarchy] Dynamic weight for ${model} in ${cityId}: ` +
            `role=${roleWeight.toFixed(2)}, combined=${combinedWeight.toFixed(3)}, ` +
            `final=${dynamicWeight.toFixed(3)}`
        );
        
        return dynamicWeight;
    }

    /**
     * Get weighted ensemble forecast for a city
     * Combines forecasts from all available models with dynamic weights
     * 
     * @param cityId - City identifier
     * @param forecasts - Array of model forecasts
     * @param variable - Weather variable type
     * @param horizonHours - Hours until forecast time
     * @returns Weighted ensemble result
     */
    getWeightedEnsembleForecast(
        cityId: string,
        forecasts: { model: ModelType; value: number }[],
        variable: WeatherVariable,
        horizonHours: number
    ): {
        mean: number;
        variance: number;
        spread: number;
        weights: WeightedForecast[];
        primaryModel: ModelType;
    } {
        const hierarchy = this.getHierarchy(cityId);
        
        // Apply bias corrections and get weights
        const weightedForecasts: WeightedForecast[] = forecasts.map(f => {
            const correctedValue = this.biasCorrector.applyBiasCorrection(
                f.model,
                f.value,
                variable,
                horizonHours
            );
            
            const dynamicWeight = this.getDynamicWeight(
                cityId,
                f.model,
                horizonHours,
                variable
            );
            
            const horizonWeight = this.biasCorrector.getHorizonWeight(f.model, horizonHours);
            const skillWeight = this.biasCorrector.getSkillWeight(f.model, variable);
            
            return {
                model: f.model,
                value: f.value,
                correctedValue,
                weight: dynamicWeight,
                horizonWeight,
                skillWeight
            };
        });
        
        // Calculate weighted mean
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (const wf of weightedForecasts) {
            weightedSum += wf.correctedValue * wf.weight;
            totalWeight += wf.weight;
        }
        
        const mean = totalWeight > 0 ? weightedSum / totalWeight : 0;
        
        // Calculate ensemble spread
        const spread = this.biasCorrector.getEnsembleSpread(
            weightedForecasts.map(wf => ({ model: wf.model, value: wf.correctedValue }))
        );
        
        // Variance includes inverse of total weight plus spread contribution
        const baseVariance = totalWeight > 0 ? 1 / totalWeight : 1;
        const variance = baseVariance + spread * spread * 0.5;
        
        logger.info(
            `[ModelHierarchy] Ensemble forecast for ${cityId}: ` +
            `mean=${mean.toFixed(2)}, variance=${variance.toFixed(4)}, ` +
            `spread=${spread.toFixed(2)}, models=${forecasts.length}`
        );
        
        return {
            mean,
            variance,
            spread,
            weights: weightedForecasts,
            primaryModel: hierarchy.primary
        };
    }

    /**
     * Apply bias correction to a single forecast value
     * Convenience method that delegates to ModelBiasCorrector
     */
    applyBiasCorrection(
        model: ModelType,
        value: number,
        variable: WeatherVariable,
        horizonHours: number
    ): number {
        return this.biasCorrector.applyBiasCorrection(model, value, variable, horizonHours);
    }

    /**
     * Get the bias corrector instance for direct access
     */
    getBiasCorrector(): ModelBiasCorrector {
        return this.biasCorrector;
    }
}

export default ModelHierarchy;
