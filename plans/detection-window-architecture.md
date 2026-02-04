# Optimized Detection Window Architecture

## Problem Statement
The current HIGH/MEDIUM/LOW urgency window system wastes API calls by polling continuously. We need a more efficient approach that:
1. Only polls during actual model update detection windows
2. Uses WebSocket alerts outside detection windows
3. Maximizes forecast change detection speed

## Weather Model Update Schedules (Research-Based)

### HRRR (High-Resolution Rapid Refresh)
- **Run times**: Every hour (00, 01, 02... 23 UTC)
- **Output delay**: 30-60 minutes after run start
- **Best detection window**: Run time + 30-50 minutes
- **Example**: 00Z run → detection window 00:30-00:50 UTC

### RAP (Rapid Refresh)
- **Run times**: Every hour (00, 01, 02... 23 UTC)
- **Output delay**: 30-50 minutes after run start
- **Best detection window**: Run time + 30-50 minutes
- **Example**: 00Z run → detection window 00:30-00:50 UTC

### GFS (Global Forecast System)
- **Run times**: 00, 06, 12, 18 UTC (4x daily)
- **Output delay**: 3-5 minutes for early forecasts
- **Best detection window**: Run time + 3-15 minutes
- **Example**: 00Z run → detection window 00:03-00:15 UTC

### ECMWF (European Centre)
- **Run times**: 00, 12 UTC (2x daily)
- **Output delay**: ~30-45 minutes
- **Best detection window**: Run time + 30-50 minutes
- **Note**: Not directly accessible via NOAA, but Open-Meteo uses it

### NAM (North American Model)
- **Run times**: 00, 06, 12, 18 UTC (4x daily)
- **Output delay**: 45-90 minutes
- **Best detection window**: Run time + 45-90 minutes

## Proposed Architecture

### Detection Windows (When to Poll)

```typescript
// Precise detection windows based on actual model behavior
const DETECTION_WINDOWS = [
  // HRRR - hourly, 30-50 min delay
  { model: 'HRRR', startOffsetMin: 30, endOffsetMin: 50, cycleIntervalHours: 1 },
  
  // RAP - hourly, 30-50 min delay  
  { model: 'RAP', startOffsetMin: 30, endOffsetMin: 50, cycleIntervalHours: 1 },
  
  // GFS - 4x daily, very fast (3-15 min)
  { model: 'GFS', startOffsetMin: 3, endOffsetMin: 15, cycleIntervalHours: 6 },
  
  // ECMWF - 2x daily, 30-50 min delay (via Open-Meteo)
  { model: 'ECMWF', startOffsetMin: 30, endOffsetMin: 50, cycleIntervalHours: 12 },
];
```

### Polling Strategy

**During Detection Windows:**
- Poll Open-Meteo every 2 seconds (batch all cities)
- If Open-Meteo fails → immediately fallback to MeteoSource
- Stop polling when window ends

**Outside Detection Windows:**
- NO polling (save API calls)
- Listen to Tomorrow.io WebSocket on port 8188
- When WebSocket receives alert → enter "burst mode"

**Burst Mode (WebSocket Triggered):**
- Poll for 60 seconds every 2 seconds
- Use Open-Meteo with immediate MeteoSource fallback
- Then return to idle (WebSocket-only)

### Key Improvements

1. **No more continuous polling** - Only poll during actual model update windows
2. **Precise timing** - Based on real model output delays
3. **WebSocket-driven outside windows** - Tomorrow.io alerts trigger burst polling
4. **Faster detection** - 2-second polling during windows vs current variable rates
5. **API efficiency** - Dramatically reduced API calls (only ~20-30 min of polling per hour for HRRR/RAP)

### Implementation Plan

1. Remove HIGH/MEDIUM/LOW urgency system from `HybridWeatherController`
2. Create new `DetectionWindowScheduler` based on actual model schedules
3. Simplify to two modes:
   - `DETECTION_WINDOW_POLLING` - During model update windows
   - `WEBSOCKET_IDLE` - Outside windows, waiting for alerts
4. Burst mode triggered by WebSocket alerts
5. Remove all urgency-related code

### Expected Benefits

- **~70% reduction in API calls** (only polling 30-40 min per hour instead of 60)
- **Faster detection** (consistent 2-second polling during critical windows)
- **No wasted calls** outside model update times
- **WebSocket alerts catch edge cases** (unexpected updates)
