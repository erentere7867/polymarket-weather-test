# Forecast Coordination Architecture

## Problem Statement

The current system has **multiple components independently polling Open-Meteo**, causing:
1. **429 Rate Limit Errors** - Exceeding 100 requests/minute limit
2. **Redundant API Calls** - Same data fetched multiple times
3. **Latency Issues** - Sequential delays (1000ms) to avoid rate limits conflict with sub-3-second requirement

### Current Polling Sources (CONFLICTING)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CURRENT: Multiple Independent Pollers                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────┐                                                     │
│  │ HybridWeatherController │ ◄── HIGH urgency: 1s polling (Open-Meteo)      │
│  │   - executeOpenMeteoPoll() │                                              │
│  └──────────┬──────────┘                                                     │
│             │                                                                │
│             ▼ 1 req/sec                                                      │
│  ┌─────────────────────┐                                                     │
│  │   Open-Meteo API    │ ◄── 100 req/min limit                              │
│  │   (100 req/min)     │                                                    │
│  └──────────▲──────────┘                                                     │
│             │                                                                │
│  ┌──────────┴──────────┐                                                     │
│  │ ApiFallbackPoller   │ ◄── DETECTION_WINDOW_START: 1s polling             │
│  │   - executePoll()   │     (INDEPENDENT - same window!)                   │
│  └─────────────────────┘                                                     │
│                                                                              │
│  RESULT: 2x API calls for same data = 429 errors                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Solution: Single Source of Truth Architecture

### Core Principle

**ONLY HybridWeatherController fetches from Open-Meteo. All other components subscribe to forecast updates via EventBus.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              NEW: Single Source of Truth Architecture                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    HybridWeatherController                          │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │              Forecast Fetch Orchestrator                     │    │    │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │    │    │
│  │  │  │ HIGH Urgency│  │MEDIUM/Low   │  │   Burst Mode        │  │    │    │
│  │  │  │ Open-Meteo  │  │ Meteosource │  │   Round-Robin       │  │    │    │
│  │  │  │  1s polling │  │ 1s polling  │  │   1 req/sec         │  │    │    │
│  │  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │    │    │
│  │  │         └─────────────────┴────────────────────┘              │    │    │
│  │  │                           │                                   │    │    │
│  │  │                    ┌──────▼──────┐                            │    │    │
│  │  │                    │ Shared Cache │                            │    │    │
│  │  │                    │  (TTL: 2s)   │                            │    │    │
│  │  │                    └──────┬──────┘                            │    │    │
│  │  └───────────────────────────┼───────────────────────────────────┘    │    │
│  │                              │                                        │    │
│  │                    ┌─────────▼─────────┐                              │    │
│  │                    │  EventBus.emit    │                              │    │
│  │                    │  FORECAST_UPDATED │                              │    │
│  │                    └─────────┬─────────┘                              │    │
│  └──────────────────────────────┼────────────────────────────────────────┘    │
│                                 │                                             │
│         ┌───────────────────────┼───────────────────────┐                     │
│         │                       │                       │                     │
│         ▼                       ▼                       ▼                     │
│  ┌─────────────┐       ┌─────────────────┐    ┌─────────────────┐            │
│  │ApiFallback  │       │ Strategy        │    │  Dashboard      │            │
│  │Poller       │       │ Components      │    │  WebSocket      │            │
│  │(SUBSCRIBER) │       │ (SUBSCRIBERS)   │    │  (SUBSCRIBER)   │            │
│  │             │       │                 │    │                 │            │
│  │ No polling! │       │ No polling!     │    │ No polling!     │            │
│  └─────────────┘       └─────────────────┘    └─────────────────┘            │
│                                                                              │
│  RESULT: 1 API call, distributed to all consumers via EventBus               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Architecture Components

### 1. Forecast Coordinator (HybridWeatherController)

**Responsibilities:**
- **Sole fetcher** of Open-Meteo data
- Manages urgency-based polling modes
- Maintains shared forecast cache
- Emits `FORECAST_UPDATED` events

**Key Changes:**
```typescript
// NEW: Shared forecast cache with 2-second TTL
private forecastCache: Map<string, CachedForecast> = new Map();
private readonly CACHE_TTL_MS = 2000; // 2 seconds

// NEW: Event emission after each fetch
private emitForecastUpdate(cityId: string, forecast: WeatherData): void {
    eventBus.emit({
        type: 'FORECAST_UPDATED',
        payload: {
            cityId,
            forecast,
            timestamp: new Date(),
            source: 'hybrid-controller',
            urgency: this.state.currentUrgency,
        },
    });
}
```

### 2. ApiFallbackPoller (Refactored to Subscriber)

**Current Behavior:** Polls Open-Meteo independently  
**New Behavior:** Subscribes to `FORECAST_UPDATED` events

```typescript
export class ApiFallbackPoller extends EventEmitter {
    // REMOVE: Independent polling logic
    // private async executePoll(): Promise<void> { ... } // DELETED
    
    // NEW: Subscribe to forecast updates
    private setupEventListeners(): void {
        // Listen for forecast updates from HybridWeatherController
        const unsubForecast = this.eventBus.on('FORECAST_UPDATED', (event) => {
            if (event.type === 'FORECAST_UPDATED') {
                this.handleForecastUpdate(event.payload);
            }
        });
        this.unsubscribers.push(unsubForecast);
        
        // Keep: Listen for FILE_CONFIRMED to stop fallback
        const unsubConfirmed = this.eventBus.on('FILE_CONFIRMED', ...);
        this.unsubscribers.push(unsubConfirmed);
        
        // Keep: Listen for DETECTION_WINDOW_START (but DON'T poll)
        const unsubWindowStart = this.eventBus.on('DETECTION_WINDOW_START', (event) => {
            // NEW: Just mark window as active, wait for FORECAST_UPDATED
            this.markDetectionWindowActive(event.payload);
        });
        this.unsubscribers.push(unsubWindowStart);
    }
    
    // NEW: Handle forecast updates from coordinator
    private handleForecastUpdate(payload: ForecastUpdatedEvent['payload']): void {
        // Transform to API_DATA_RECEIVED format for backward compatibility
        const event: ApiDataReceivedEvent = {
            type: 'API_DATA_RECEIVED',
            payload: {
                cityId: payload.cityId,
                cityName: payload.forecast.locationName || payload.cityId,
                model: this.detectModel(),
                cycleHour: this.detectCycleHour(),
                forecastHour: 0,
                temperatureC: payload.forecast.hourly[0]?.temperatureC || 0,
                temperatureF: payload.forecast.hourly[0]?.temperatureF || 0,
                windSpeedMph: payload.forecast.hourly[0]?.windSpeedMph || 0,
                precipitationMm: 0, // Calculate from forecast
                timestamp: payload.timestamp,
                confidence: 'LOW',
                source: 'API',
                status: 'UNCONFIRMED',
            },
        };
        
        this.eventBus.emit(event);
        this.emit('apiDataReceived', event.payload);
    }
}
```

### 3. New Event Type: FORECAST_UPDATED

```typescript
// Add to src/realtime/event-bus.ts
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

// Add to Event union type
export type Event =
    | ...
    | ForecastUpdatedEvent;
```

## Latency Optimization Strategy

### Sub-3-Second Requirement Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Sub-3-Second Latency Budget                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Component                    Target    Maximum   Notes                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Open-Meteo API Call          <800ms   <1500ms   Single batch request       │
│  Response Processing          <100ms   <200ms    Parse & cache              │
│  EventBus Dispatch            <50ms    <100ms    Synchronous emit           │
│  Subscriber Processing        <100ms   <200ms    Transform & forward        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  TOTAL                        <1050ms  <2000ms   Well under 3s limit        │
│  HEADROOM                     1950ms   1000ms    Safety margin              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Eliminating Sequential Delays

**Current (with 1000ms delay):**
```typescript
// OLD: Sequential requests with 1000ms delay
for (const location of locations) {
    await this.getHourlyForecast(location.coords, false);
    await new Promise(resolve => setTimeout(resolve, 1000)); // TOO SLOW!
}
// 10 cities = 10+ seconds (FAILS 3s requirement)
```

**New (single batch request):**
```typescript
// NEW: Single batch request, no delays needed
const batchResults = await openMeteoClient.getHourlyForecastBatch(
    locations, 
    false // No cache during HIGH urgency
);
// 10 cities = 1 API call = <1500ms total (MEETS 3s requirement)
```

### Cache Strategy for Speed

```typescript
// Two-tier caching system

// Tier 1: In-memory forecast cache (2-second TTL)
// - Used by all subscribers
// - Eliminates redundant processing
private forecastCache: Map<string, {
    data: WeatherData;
    fetchedAt: Date;
    expiresAt: Date;
}>;

// Tier 2: OpenMeteo client cache (5-minute TTL)
// - Used only during LOW urgency
// - Reduces API calls during idle periods
```

## Implementation Plan

### Phase 1: Add FORECAST_UPDATED Event (15 min)
1. Add new event type to [`src/realtime/event-bus.ts`](src/realtime/event-bus.ts:1)
2. Update Event union type
3. Add event payload interface

### Phase 2: Refactor ApiFallbackPoller (30 min)
1. Remove [`executePoll()`](src/weather/api-fallback-poller.ts:188) method
2. Remove [`startPolling()`](src/weather/api-fallback-poller.ts:127) polling logic
3. Add [`handleForecastUpdate()`](src/weather/api-fallback-poller.ts:93) subscriber
4. Keep FILE_CONFIRMED handling for backward compatibility

### Phase 3: Enhance HybridWeatherController (30 min)
1. Add shared forecast cache
2. Emit FORECAST_UPDATED after each poll
3. Remove rate limit delays (no longer needed)
4. Optimize batch request sizing

### Phase 4: Remove Sequential Delays (15 min)
1. Remove 1000ms delay in [`fetchBatchLocations`](src/weather/openmeteo-client.ts:663) fallback
2. Remove 500ms chunk delay in [`getHourlyForecastBatch`](src/weather/openmeteo-client.ts:530)
3. Increase MAX_BATCH_SIZE for efficiency

## Benefits

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| API Calls (HIGH urgency) | 2+ per second | 1 per second | **50% reduction** |
| Latency (10 cities) | 10+ seconds | <1.5 seconds | **85% faster** |
| 429 Errors | Frequent | Eliminated | **100% reduction** |
| Code Complexity | High (coordination bugs) | Low (clear ownership) | **Simplified** |

## Risk Mitigation

### Risk: Single Point of Failure
**Mitigation:** 
- HybridWeatherController has multiple provider fallbacks
- If Open-Meteo fails, switches to Meteosource/Tomorrow.io
- ApiFallbackPoller can be quickly reverted to polling mode if needed

### Risk: EventBus Backpressure
**Mitigation:**
- Events are small (just cityId + forecast reference)
- Subscribers process asynchronously
- Can add event queuing if needed

### Risk: Cache Staleness
**Mitigation:**
- 2-second TTL ensures freshness
- `useCache=false` during HIGH urgency
- Cache only used for subscriber distribution, not API optimization
