# Forecast Coordination Implementation Plan

## Overview

This document provides the detailed implementation steps for the Single Source of Truth architecture. The implementation eliminates redundant polling and achieves sub-3-second forecast fetching.

---

## Implementation Checklist

### Phase 1: EventBus Enhancement
**Files:** [`src/realtime/event-bus.ts`](src/realtime/event-bus.ts:1)

- [ ] Add `FORECAST_UPDATED` to EventType union
- [ ] Add `ForecastUpdatedEvent` interface
- [ ] Update Event union type
- [ ] Add `FORECAST_BATCH_UPDATED` for batch updates (optional optimization)

### Phase 2: HybridWeatherController Enhancement
**Files:** [`src/realtime/hybrid-weather-controller.ts`](src/realtime/hybrid-weather-controller.ts:1)

- [ ] Add shared forecast cache (2-second TTL)
- [ ] Add `emitForecastUpdate()` method
- [ ] Modify `executeOpenMeteoPoll()` to emit events
- [ ] Modify `executeMeteosourcePoll()` to emit events
- [ ] Add `getCachedForecast(cityId)` public method
- [ ] Remove any redundant polling logic

### Phase 3: ApiFallbackPoller Refactoring
**Files:** [`src/weather/api-fallback-poller.ts`](src/weather/api-fallback-poller.ts:1)

- [ ] Remove `executePoll()` method
- [ ] Remove `startPolling()` polling logic
- [ ] Add `handleForecastUpdate()` subscriber method
- [ ] Modify `setupEventListeners()` to subscribe to FORECAST_UPDATED
- [ ] Keep FILE_CONFIRMED handling (still needed)
- [ ] Keep DETECTION_WINDOW_START handling (mark active, don't poll)
- [ ] Add `isWindowActive` flag for tracking

### Phase 4: OpenMeteoClient Optimization
**Files:** [`src/weather/openmeteo-client.ts`](src/weather/openmeteo-client.ts:1)

- [ ] Remove 1000ms sequential delay in fallback
- [ ] Remove 500ms chunk delay
- [ ] Increase MAX_BATCH_SIZE from 10 to 50
- [ ] Optimize error handling for 429s
- [ ] Add batch request metrics logging

### Phase 5: Testing & Validation
**Files:** Test files

- [ ] Test single-source fetching
- [ ] Verify sub-3-second latency
- [ ] Confirm no 429 errors
- [ ] Validate EventBus event flow
- [ ] Test fallback behavior

---

## Detailed Code Changes

### Phase 1: EventBus Enhancement

```typescript
// src/realtime/event-bus.ts

// Add to EventType union (line ~10)
export type EventType =
    | 'FORECAST_TRIGGER'
    | 'FETCH_MODE_ENTER'
    | 'FETCH_MODE_EXIT'
    | 'PROVIDER_FETCH'
    | 'FORECAST_CHANGED'
    | 'FILE_DETECTED'
    | 'FILE_CONFIRMED'
    | 'DETECTION_WINDOW_START'
    | 'API_DATA_RECEIVED'
    | 'FORECAST_CHANGE'
    | 'FORECAST_UPDATED'        // NEW
    | 'FORECAST_BATCH_UPDATED'; // NEW (optional)

// Add new interface (after line ~160)
export interface ForecastUpdatedEvent {
    type: 'FORECAST_UPDATED';
    payload: {
        cityId: string;
        forecast: WeatherData;
        timestamp: Date;
        source: 'hybrid-controller';
        urgency: UrgencyLevel;
        fetchLatencyMs: number;
    };
}

export interface ForecastBatchUpdatedEvent {
    type: 'FORECAST_BATCH_UPDATED';
    payload: {
        cities: Array<{
            cityId: string;
            forecast: WeatherData;
        }>;
        timestamp: Date;
        source: 'hybrid-controller';
        urgency: UrgencyLevel;
        fetchLatencyMs: number;
        totalCities: number;
    };
}

// Update Event union (line ~164)
export type Event =
    | ForecastTriggerEvent
    | FetchModeEnterEvent
    | FetchModeExitEvent
    | ProviderFetchEvent
    | ForecastChangedEvent
    | FileDetectedEvent
    | FileConfirmedEvent
    | DetectionWindowStartEvent
    | ApiDataReceivedEvent
    | ForecastChangeEvent
    | ForecastUpdatedEvent        // NEW
    | ForecastBatchUpdatedEvent;  // NEW
```

### Phase 2: HybridWeatherController Enhancement

```typescript
// src/realtime/hybrid-weather-controller.ts

// Add to class properties (around line 240)
private forecastCache: Map<string, {
    data: WeatherData;
    fetchedAt: Date;
    expiresAt: Date;
}> = new Map();
private readonly FORECAST_CACHE_TTL_MS = 2000; // 2 seconds

// Add public method to access cache (after line 648)
public getCachedForecast(cityId: string): WeatherData | null {
    const cached = this.forecastCache.get(cityId);
    if (!cached) return null;
    if (cached.expiresAt.getTime() < Date.now()) {
        this.forecastCache.delete(cityId);
        return null;
    }
    return cached.data;
}

// Add emit method (new method)
private emitForecastUpdate(
    cityId: string, 
    forecast: WeatherData, 
    fetchLatencyMs: number
): void {
    // Update cache
    this.forecastCache.set(cityId, {
        data: forecast,
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + this.FORECAST_CACHE_TTL_MS),
    });
    
    // Emit event
    eventBus.emit({
        type: 'FORECAST_UPDATED',
        payload: {
            cityId,
            forecast,
            timestamp: new Date(),
            source: 'hybrid-controller',
            urgency: this.state.currentUrgency,
            fetchLatencyMs,
        },
    });
}

// Modify executeOpenMeteoPoll (around line 809)
private async executeOpenMeteoPoll(): Promise<void> {
    const pollStartTime = Date.now();
    
    // ... existing code until batch request ...
    
    try {
        // Execute SINGLE batch request
        const batchResults = await openMeteoClient.getHourlyForecastBatch(locations, useCache);
        
        // Record API call
        this.apiTracker.recordCall('openmeteo', true);
        
        // Calculate latency
        const fetchLatencyMs = Date.now() - pollStartTime;
        
        // Distribute results and emit events
        for (let i = 0; i < batchResults.length && i < cityLocations.length; i++) {
            const result = batchResults[i];
            const { cityId } = cityLocations[i];
            
            // NEW: Emit forecast update for each city
            this.emitForecastUpdate(cityId, result, fetchLatencyMs);
            
            // Emit provider fetch event (existing)
            eventBus.emit({
                type: 'PROVIDER_FETCH',
                payload: {
                    cityId,
                    provider: 'open-meteo',
                    success: true,
                    hasChanges: true,
                },
            });
        }
        
        // NEW: Emit batch update event (optional optimization)
        eventBus.emit({
            type: 'FORECAST_BATCH_UPDATED',
            payload: {
                cities: batchResults.map((result, i) => ({
                    cityId: cityLocations[i]?.cityId || 'unknown',
                    forecast: result,
                })),
                timestamp: new Date(),
                source: 'hybrid-controller',
                urgency: this.state.currentUrgency,
                fetchLatencyMs,
                totalCities: batchResults.length,
            },
        });
        
    } catch (error) {
        this.apiTracker.recordCall('openmeteo', false);
        logger.error('Open-Meteo batch poll failed', {
            error: (error as Error).message,
        });
    }
}
```

### Phase 3: ApiFallbackPoller Refactoring

```typescript
// src/weather/api-fallback-poller.ts

// REMOVE these methods entirely:
// - private async executePoll(): Promise<void> (lines 188-273)
// - public startPolling(): void (lines 127-183)
// - Remove pollIntervalId from PollingSession interface

// MODIFY PollingSession interface (line 60)
interface PollingSession {
    model: ModelType;
    cycleHour: number;
    windowId: string;
    startTime: Date;
    // pollIntervalId: NodeJS.Timeout; // REMOVED
    timeoutId: NodeJS.Timeout;
    isActive: boolean;
    citiesPolled: Set<string>;
    // NEW: Track received forecasts
    receivedForecasts: Map<string, WeatherData>;
}

// MODIFY setupEventListeners (line 93)
private setupEventListeners(): void {
    // Listen for FILE_CONFIRMED to stop polling immediately
    const unsubConfirmed = this.eventBus.on('FILE_CONFIRMED', (event) => {
        if (event.type === 'FILE_CONFIRMED') {
            const { model, cycleHour } = event.payload;
            this.handleFileConfirmed(model, cycleHour);
        }
    });
    this.unsubscribers.push(unsubConfirmed);

    // Listen for DETECTION_WINDOW_START to begin monitoring
    const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
        if (event.type === 'DETECTION_WINDOW_START') {
            const { model, cycleHour, windowStart } = event.payload;
            this.startMonitoring(model, cycleHour, windowStart);
        }
    });
    this.unsubscribers.push(unsubWindowStart);
    
    // NEW: Listen for FORECAST_UPDATED from HybridWeatherController
    const unsubForecast = this.eventBus.on('FORECAST_UPDATED', (event) => {
        if (event.type === 'FORECAST_UPDATED') {
            this.handleForecastUpdate(event.payload);
        }
    });
    this.unsubscribers.push(unsubForecast);
    
    // NEW: Listen for FORECAST_BATCH_UPDATED (optional)
    const unsubBatchForecast = this.eventBus.on('FORECAST_BATCH_UPDATED', (event) => {
        if (event.type === 'FORECAST_BATCH_UPDATED') {
            this.handleBatchForecastUpdate(event.payload);
        }
    });
    this.unsubscribers.push(unsubBatchForecast);
}

// NEW: Handle forecast updates
private handleForecastUpdate(payload: {
    cityId: string;
    forecast: WeatherData;
    timestamp: Date;
    source: string;
    urgency: string;
    fetchLatencyMs: number;
}): void {
    // Find active session for this city
    for (const session of this.sessions.values()) {
        if (!session.isActive) continue;
        
        const cityName = payload.forecast.locationName || payload.cityId;
        const normalizedCityName = cityName.toLowerCase().replace(/\s+/g, '_');
        
        // Store forecast in session
        session.receivedForecasts.set(payload.cityId, payload.forecast);
        session.citiesPolled.add(payload.cityId);
        
        // Transform to API_DATA_RECEIVED format
        const currentForecast = payload.forecast.hourly[0];
        if (!currentForecast) continue;
        
        const event: ApiDataReceivedEvent = {
            type: 'API_DATA_RECEIVED',
            payload: {
                cityId: payload.cityId,
                cityName: cityName,
                model: session.model,
                cycleHour: session.cycleHour,
                forecastHour: 0,
                temperatureC: currentForecast.temperatureC,
                temperatureF: currentForecast.temperatureF,
                windSpeedMph: currentForecast.windSpeedMph || 0,
                precipitationMm: currentForecast.snowfallInches 
                    ? currentForecast.snowfallInches * 25.4 
                    : 0,
                timestamp: payload.timestamp,
                confidence: 'LOW',
                source: 'API',
                status: 'UNCONFIRMED',
            },
        };
        
        this.eventBus.emit(event);
        this.emit('apiDataReceived', event.payload);
        
        logger.debug(
            `[ApiFallbackPoller] Received forecast for ${payload.cityId} ` +
            `via EventBus (${payload.fetchLatencyMs}ms fetch latency)`
        );
    }
}

// NEW: Handle batch forecast updates
private handleBatchForecastUpdate(payload: {
    cities: Array<{ cityId: string; forecast: WeatherData }>;
    timestamp: Date;
    source: string;
    urgency: string;
    fetchLatencyMs: number;
    totalCities: number;
}): void {
    for (const { cityId, forecast } of payload.cities) {
        this.handleForecastUpdate({
            cityId,
            forecast,
            timestamp: payload.timestamp,
            source: payload.source,
            urgency: payload.urgency,
            fetchLatencyMs: payload.fetchLatencyMs,
        });
    }
}

// RENAME startPolling to startMonitoring (line 127)
public startMonitoring(
    model: ModelType,
    cycleHour: number,
    windowStart: Date
): void {
    const windowId = this.getWindowId(model, cycleHour);

    // Don't start if already monitoring this window
    if (this.sessions.has(windowId)) {
        logger.debug(`[ApiFallbackPoller] Already monitoring ${windowId}`);
        return;
    }

    logger.info(
        `[ApiFallbackPoller] Starting monitoring for ${model} ${String(cycleHour).padStart(2, '0')}Z ` +
        `(waiting for FORECAST_UPDATED events)`
    );

    // Create session (NO POLLING)
    const session: PollingSession = {
        model,
        cycleHour,
        windowId,
        startTime: new Date(),
        timeoutId: null as unknown as NodeJS.Timeout,
        isActive: true,
        citiesPolled: new Set(),
        receivedForecasts: new Map(), // NEW
    };

    // Set timeout to stop after max duration
    const maxDurationMs = this.config.maxDurationMinutes * 60 * 1000;
    session.timeoutId = setTimeout(() => {
        logger.info(
            `[ApiFallbackPoller] Max duration reached for ${windowId}, stopping monitoring`
        );
        this.stopMonitoring(windowId);
    }, maxDurationMs);

    this.sessions.set(windowId, session);

    this.emit('monitoringStarted', {
        model,
        cycleHour,
        windowId,
        maxDurationMinutes: this.config.maxDurationMinutes,
    });
}

// RENAME stopPolling to stopMonitoring (line 292)
public stopMonitoring(windowId: string): void {
    const session = this.sessions.get(windowId);
    if (!session) return;

    session.isActive = false;

    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
    }

    const durationMs = Date.now() - session.startTime.getTime();

    logger.info(
        `[ApiFallbackPoller] Stopped monitoring for ${windowId} ` +
        `(duration: ${(durationMs / 1000).toFixed(1)}s, ` +
        `cities received: ${session.citiesPolled.size})`
    );

    this.emit('monitoringStopped', {
        windowId,
        model: session.model,
        cycleHour: session.cycleHour,
        durationMs,
        citiesReceived: session.citiesPolled.size,
    });

    this.sessions.delete(windowId);
}
```

### Phase 4: OpenMeteoClient Optimization

```typescript
// src/weather/openmeteo-client.ts

// MODIFY MAX_BATCH_SIZE (line 667)
// OLD: const MAX_BATCH_SIZE = 10;
// NEW:
const MAX_BATCH_SIZE = 50; // Increased - no longer need small batches

// REMOVE delays in fetchBatchLocations (lines 675-678)
// REMOVE this code:
// if (i + MAX_BATCH_SIZE < locations.length) {
//     await new Promise(resolve => setTimeout(resolve, 500));
// }

// REMOVE sequential delay in fallback (lines 759-760)
// REMOVE this code:
// await new Promise(resolve => setTimeout(resolve, 1000));

// OPTIMIZED fallback (lines 750-767)
// Fall back to parallel requests instead of sequential
logger.warn('Falling back to parallel API calls');
const results: WeatherData[] = [];
const errors: Array<{ location: any; error: Error }> = [];

// Execute all requests in parallel
const promises = locations.map(async (location) => {
    try {
        const data = await this.getHourlyForecast(location.coords, false);
        if (location.locationName) {
            data.locationName = location.locationName;
        }
        return { success: true, data, location };
    } catch (e) {
        return { success: false, error: e as Error, location };
    }
});

const settled = await Promise.allSettled(promises);

for (const result of settled) {
    if (result.status === 'fulfilled' && result.value.success) {
        results.push(result.value.data);
    } else {
        const error = result.status === 'fulfilled' 
            ? result.value.error 
            : result.reason;
        logger.error(`Failed to fetch location`, { error: error?.message });
        errors.push({ location: result.value?.location, error });
    }
}

if (errors.length > 0 && results.length === 0) {
    throw new Error(`All ${locations.length} fallback requests failed`);
}

return results;
```

---

## Testing Strategy

### Unit Tests

```typescript
// Test: ApiFallbackPoller subscribes correctly
describe('ApiFallbackPoller', () => {
    it('should emit API_DATA_RECEIVED when FORECAST_UPDATED received', () => {
        const poller = new ApiFallbackPoller();
        const emitSpy = jest.spyOn(poller, 'emit');
        
        // Simulate FORECAST_UPDATED event
        eventBus.emit({
            type: 'FORECAST_UPDATED',
            payload: {
                cityId: 'new_york',
                forecast: mockForecast,
                timestamp: new Date(),
                source: 'hybrid-controller',
                urgency: 'HIGH',
                fetchLatencyMs: 500,
            },
        });
        
        expect(emitSpy).toHaveBeenCalledWith('apiDataReceived', expect.any(Object));
    });
    
    it('should not make independent API calls', () => {
        const poller = new ApiFallbackPoller();
        const fetchSpy = jest.spyOn(openMeteoClient, 'getHourlyForecastBatch');
        
        poller.startMonitoring('GFS', 0, new Date());
        
        // Should not call fetch directly
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// Test: HybridWeatherController emits events
describe('HybridWeatherController', () => {
    it('should emit FORECAST_UPDATED after poll', async () => {
        const controller = new HybridWeatherController(...);
        const emitSpy = jest.spyOn(eventBus, 'emit');
        
        await controller.executeOpenMeteoPoll();
        
        expect(emitSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'FORECAST_UPDATED' })
        );
    });
});
```

### Integration Tests

```typescript
// Test: End-to-end latency
describe('Forecast Coordination Latency', () => {
    it('should achieve sub-3-second latency', async () => {
        const startTime = Date.now();
        
        // Trigger poll
        await controller.executeOpenMeteoPoll();
        
        // Wait for ApiFallbackPoller to receive
        const receivedEvent = await waitForEvent('apiDataReceived');
        
        const latency = Date.now() - startTime;
        expect(latency).toBeLessThan(3000);
    });
});

// Test: No duplicate API calls
describe('API Call Efficiency', () => {
    it('should make only 1 API call for multiple subscribers', async () => {
        const fetchSpy = jest.spyOn(openMeteoClient, 'getHourlyForecastBatch');
        
        // Start controller and multiple pollers
        controller.start();
        poller1.startMonitoring('GFS', 0, new Date());
        poller2.startMonitoring('GFS', 0, new Date());
        
        // Wait for poll cycle
        await wait(1100);
        
        // Should only be 1 call
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
```

---

## Rollback Plan

If issues arise, revert these changes:

1. **EventBus**: Remove FORECAST_UPDATED event types
2. **HybridWeatherController**: Remove emitForecastUpdate calls
3. **ApiFallbackPoller**: Restore executePoll() and startPolling() methods
4. **OpenMeteoClient**: Restore 1000ms delays

Rollback can be done by reverting the specific commits or applying the inverse patches.

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| API Calls per Second | ≤1 | Monitor apiCallTracker |
| End-to-End Latency | <3000ms | Log timestamps |
| 429 Error Rate | 0 | Error logs |
| Event Delivery | 100% | EventBus metrics |
