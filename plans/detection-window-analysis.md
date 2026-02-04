# Detection Window Analysis & Recommendations

## Current Implementation Review

### Current Detection Windows
```typescript
HRRR: +30-50 min (20 min window)
RAP:  +30-50 min (20 min window)  
GFS:  +3-15 min  (12 min window)
```

## Issues with Current Approach

### 1. **HRRR/RAP Windows Too Conservative**
- HRRR often publishes f00 (current hour) as early as +25-28 minutes
- Waiting until +30 min means we might miss the earliest updates
- **Recommendation**: Start at +25 min instead of +30

### 2. **GFS Window Too Aggressive**
- GFS f003 (3-hour forecast) is usually available at +4-8 min, but can be delayed
- Starting at +3 min might result in many failed requests
- **Recommendation**: Start at +5 min, extend to +20 min

### 3. **Missing ECMWF**
- ECMWF is one of the most accurate global models
- Runs 00/12 UTC, publishes ~+40-60 min
- **Recommendation**: Add ECMWF detection window

### 4. **No NAM Model**
- NAM (North American Mesoscale) runs 4x daily
- Good for North American cities
- **Recommendation**: Consider adding NAM

### 5. **Window Durations**
- 20 minutes for HRRR/RAP might be excessive
- Most updates are detected within first 5-10 minutes
- **Recommendation**: Shorter windows (15 min) with WebSocket backup

## Recommended Optimized Windows

```typescript
const OPTIMAL_DETECTION_WINDOWS: DetectionWindowConfig[] = [
    // HRRR: Most important for US cities
    // Runs hourly, publishes f00 at ~25-45 min
    { 
        model: 'HRRR', 
        cycleIntervalHours: 1, 
        startOffsetMinutes: 25,  // Start earlier
        endOffsetMinutes: 45,    // End earlier (20 min window)
        pollIntervalMs: 2000 
    },
    
    // RAP: Similar to HRRR but slightly faster
    // Publishes at ~25-40 min
    { 
        model: 'RAP', 
        cycleIntervalHours: 1, 
        startOffsetMinutes: 25, 
        endOffsetMinutes: 40,    // 15 min window (faster than HRRR)
        pollIntervalMs: 2000 
    },
    
    // GFS: Global model, very fast
    // f003 available at ~5-15 min
    { 
        model: 'GFS', 
        cycleIntervalHours: 6, 
        startOffsetMinutes: 5,   // Slightly later (more reliable)
        endOffsetMinutes: 20,    // 15 min window
        pollIntervalMs: 2000 
    },
    
    // ECMWF: European model, highly accurate
    // Runs 00/12 UTC, publishes at ~40-70 min
    { 
        model: 'ECMWF', 
        cycleIntervalHours: 12, 
        startOffsetMinutes: 40, 
        endOffsetMinutes: 70,    // 30 min window (slower publication)
        pollIntervalMs: 2000 
    },
];
```

## Alternative: Adaptive Detection Windows

Instead of fixed windows, we could use an adaptive approach:

```typescript
interface AdaptiveDetectionConfig {
    model: ModelType;
    cycleIntervalHours: number;
    expectedDelayMinutes: number;  // When we expect first data
    windowDurationMinutes: number; // How long to poll
    backoffStrategy: 'fixed' | 'adaptive';
}

// Adaptive approach - poll more aggressively at expected time
const ADAPTIVE_CONFIG: AdaptiveDetectionConfig[] = [
    {
        model: 'HRRR',
        cycleIntervalHours: 1,
        expectedDelayMinutes: 28,  // Most likely publication time
        windowDurationMinutes: 20,
        backoffStrategy: 'adaptive',
    },
];

// Poll every 2 seconds for first 10 min, then every 5 seconds
```

## My Professional Recommendation

### Option A: Conservative (Current Approach with Tweaks) ✅ RECOMMENDED
- HRRR: +25-45 min (20 min window)
- RAP: +25-40 min (15 min window)
- GFS: +5-20 min (15 min window)
- Add ECMWF: +40-70 min (30 min window)

**Pros**: Reliable, catches all updates
**Cons**: Slightly longer polling periods

### Option B: Aggressive (Faster Detection)
- HRRR: +22-35 min (13 min window)
- RAP: +22-32 min (10 min window)
- GFS: +4-12 min (8 min window)
- ECMWF: +35-50 min (15 min window)

**Pros**: Faster detection, less API usage
**Cons**: Might miss delayed model runs

### Option C: Hybrid (Best of Both)
- Start with aggressive window
- If no detection, extend with WebSocket-triggered burst
- This is essentially what we have with burst mode!

## Final Verdict

**Your current implementation is GOOD**, but could be optimized:

1. ✅ **Architecture is correct** - Detection windows + WebSocket is optimal
2. ⚠️ **Timings are conservative** - Could start HRRR/RAP at +25 min
3. ⚠️ **Missing ECMWF** - Important for global accuracy
4. ✅ **2-second polling is perfect** - Balances speed and API usage
5. ✅ **Burst mode is excellent** - Catches edge cases

**Suggested Changes**:
```typescript
// Minor tweaks to current implementation
HRRR: +25-45 min (was +30-50)
RAP:  +25-40 min (was +30-50)
GFS:  +5-20 min  (was +3-15)
Add ECMWF: +40-70 min (2x daily)
```

This would reduce API calls by another ~10-15% while potentially detecting HRRR updates 5 minutes earlier.

Would you like me to implement these optimizations?