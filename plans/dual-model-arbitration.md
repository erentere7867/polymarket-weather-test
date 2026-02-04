# Model Arbitration Logic Design

## Overview
This document outlines the design for "Model Arbitration Logic" to handle dual weather models (GFS and ECMWF) for European cities. The goal is to intelligently decide when to update a forecast based on the arrival time and source of the data, favoring ECMWF while allowing GFS to win races or provide significantly fresher data.

## 1. Logic Location
The arbitration logic will reside in **`src/realtime/hybrid-weather-controller.ts`**.
The `HybridWeatherController` is already responsible for coordinating data sources and modes. It is the natural place to intercept `FILE_CONFIRMED` or `FORECAST_CHANGED` events and decide whether to propagate them to the `DataStore` or `OrderExecutor`.

## 2. State Requirements
We need to track the last applied update's source and timestamp for each city.

**New State Interface:**
We will add a tracking map to `HybridWeatherController` (or its state):

```typescript
interface CityUpdateState {
    lastUpdateSource: 'GFS' | 'ECMWF' | 'OTHER';
    lastUpdateTimestamp: Date; // Wall-clock time when the update was processed
    lastModelRunTime: Date;    // The 'runDate' of the model (e.g., 12z)
}

// In HybridWeatherController
private cityUpdateStates: Map<string, CityUpdateState> = new Map();
```

## 3. Arbitration Logic (Pseudocode)
This function `shouldUpdateForecast` will be called whenever a new forecast is available (e.g., from `FileConfirmedEvent`).

```typescript
/**
 * Determines if a new forecast should be applied based on arbitration rules.
 * 
 * Rules:
 * 1. Race: Whichever arrives first triggers update.
 * 2. ECMWF Preference: If ECMWF arrives after GFS, always update.
 * 3. GFS Restriction: If GFS arrives after ECMWF:
 *    - < 5 mins since ECMWF: IGNORE GFS.
 *    - > 1 hour since ECMWF: UPDATE with GFS (freshness wins).
 *    - 5m - 1h: IGNORE (Implicitly prefer ECMWF).
 */
function shouldUpdateForecast(
    cityId: string, 
    newModel: 'GFS' | 'ECMWF', 
    newTimestamp: Date // Current wall-clock time
): boolean {
    const currentState = this.cityUpdateStates.get(cityId);

    // Rule 1: First arrival (no previous state) -> Update
    if (!currentState) {
        return true;
    }

    // Rule 2: ECMWF Preference
    // If the new update is ECMWF, we generally always accept it.
    // (Even if we just updated GFS 1 second ago).
    if (newModel === 'ECMWF') {
        return true; 
    }

    // Rule 3: GFS Handling
    if (newModel === 'GFS') {
        // If previous was also GFS, update (newer GFS replaces older GFS)
        if (currentState.lastUpdateSource === 'GFS') {
            return true;
        }

        // If previous was ECMWF, check time diff
        if (currentState.lastUpdateSource === 'ECMWF') {
            const timeSinceLastUpdateMs = newTimestamp.getTime() - currentState.lastUpdateTimestamp.getTime();
            const timeSinceLastUpdateMinutes = timeSinceLastUpdateMs / (1000 * 60);

            // "Short time" (< 5 mins) -> Ignore
            if (timeSinceLastUpdateMinutes < 5) {
                logger.info(`Ignoring GFS update for ${cityId}: Too close to ECMWF update (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
                return false;
            }

            // "Long time" (> 1 hour) -> Update
            if (timeSinceLastUpdateMinutes > 60) {
                 logger.info(`Accepting GFS update for ${cityId}: Significantly fresher than ECMWF (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
                return true;
            }

            // Implicit: 5m - 60m -> Ignore (Stick with preferred ECMWF)
            logger.info(`Ignoring GFS update for ${cityId}: Within ECMWF preference window (${timeSinceLastUpdateMinutes.toFixed(1)}m)`);
            return false;
        }
    }

    // Default: Allow update (e.g. from other sources if we support them)
    return true;
}
```

## 4. Configuration Changes

### A. Enable ECMWF Scheduling
**File:** `src/weather/schedule-manager.ts`
**Change:** Update `getUpcomingRuns` to include ECMWF checks.

```typescript
// Add to getUpcomingRuns loop:
// ECMWF runs at 00Z and 12Z
if (cycleHour % 12 === 0) {
    schedules.push(this.calculateDetectionWindow('ECMWF', cycleHour, checkDate));
}
```

### B. Configure European Cities
**File:** `src/weather/types.ts`
**Change:** Update `CITY_MODEL_CONFIGS` for European cities to explicitly list GFS and ECMWF.

```typescript
// Update entries for London, Ankara, etc.
{ 
    cityName: 'London', 
    primaryModel: 'ECMWF', // Make ECMWF primary if preferred
    fallbackModels: ['GFS'] 
},
// ... apply to other European cities
```

## 5. Implementation Strategy
1.  **Modify `schedule-manager.ts`** to start detecting ECMWF files.
2.  **Modify `types.ts`** to update city configs.
3.  **Modify `hybrid-weather-controller.ts`**:
    *   Add `cityUpdateStates` map.
    *   Implement `shouldUpdateForecast` logic.
    *   In the event handler for `FILE_CONFIRMED` (or wherever the forecast update is triggered), call `shouldUpdateForecast` before proceeding.
