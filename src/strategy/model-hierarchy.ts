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
    'new york': 'US',
    'los angeles': 'US',
    'chicago': 'US',
    'miami': 'US',
    'houston': 'US',
    'phoenix': 'US',
    'denver': 'US',
    'seattle': 'US',
    'washington dc': 'US',
    'boston': 'US',
    'atlanta': 'US',
    'san francisco': 'US',
    'dallas': 'US',
    'las vegas': 'US',

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

    // Global Cities - use GFS
    'tokyo': 'GLOBAL',
    'sydney': 'GLOBAL',
    'hong kong': 'GLOBAL',
    'singapore': 'GLOBAL',
    'dubai': 'GLOBAL',
    'mumbai': 'GLOBAL',
    'são paulo': 'GLOBAL',
    'mexico city': 'GLOBAL',
    'toronto': 'US', // Close enough to use HRRR coverage
    'vancouver': 'US', // Close enough to use HRRR coverage
};

/**
 * Model Hierarchy Manager
 * Determines which models to use for each city and validates model roles
 */
export class ModelHierarchy {
    private hierarchies: Map<string, ModelHierarchyConfig> = new Map();

    constructor() {
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
        const normalized = cityId.toLowerCase().trim();
        return this.hierarchies.get(normalized) || GLOBAL_HIERARCHY;
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
     * Get region for a city
     */
    getRegion(cityId: string): 'US' | 'EUROPE' | 'GLOBAL' {
        const normalized = cityId.toLowerCase().trim();
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
        const normalized = cityId.toLowerCase().trim();
        CITY_REGIONS[normalized] = region;
        this.hierarchies.set(normalized, this.getHierarchyForRegion(region));
        logger.info(`[ModelHierarchy] Set ${cityId} to region ${region}`);
    }
}

export default ModelHierarchy;
