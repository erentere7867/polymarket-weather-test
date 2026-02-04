# File-Based Weather Ingestion System

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Configuration](#configuration)
4. [Operations](#operations)
5. [Model Reference](#model-reference)
6. [City Coverage](#city-coverage)
7. [Troubleshooting](#troubleshooting)

---

## Overview

The File-Based Weather Ingestion System provides **sub-5-second latency** weather forecast detection by monitoring NOAA S3 buckets directly for model file appearance. This is significantly faster than traditional API polling methods.

### Key Features

- **Dual-Path Architecture**: File-based primary detection with API fallback
- **Sub-5-Second Latency**: From file appearance to `FORECAST_CHANGE` event
- **Direct S3 Access**: Uses HeadObject polling on public NOAA buckets
- **Three NOAA Models**: HRRR, RAP, and GFS coverage
- **13 Supported Cities**: CONUS and international locations
- **Automatic Fallback**: API polling activates if file detection fails

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Detection Cycle                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  UTC 00:25    ┌────────────────────────────────────────────────────┐    │
│  (25 min      │ ScheduleManager pre-computes expected filename     │    │
│   after       │ hrrr.20260201/conus/hrrr.t00z.wrfsfcf00.grib2      │    │
│   cycle)      └────────────────────────────────────────────────────┘    │
│                    │                                                     │
│                    ▼                                                     │
│  UTC 00:30    ┌────────────────────────────────────────────────────┐    │
│  (Detection   │ Detection window opens                             │    │
│   window      │ S3FileDetector starts HeadObject polling           │    │
│   opens)      └────────────────────────────────────────────────────┘    │
│                    │                                                     │
│                    ▼ (every 150ms)                                       │
│              ┌────────────────────────────────────────────────────┐     │
│              │ HEAD s3://noaa-hrrr-pds/.../hrrr.t00z.wrfsfcf00   │     │
│              │ 404 Not Found → Wait 150ms → Retry                 │     │
│              └────────────────────────────────────────────────────┘     │
│                    │                                                     │
│  UTC 00:48    ◄────┘ File appears!                                      │
│  (File        ┌────────────────────────────────────────────────────┐    │
│   detected)   │ 200 OK → Download → Parse → Emit FILE_CONFIRMED    │    │
│               └────────────────────────────────────────────────────┘    │
│                    │                                                     │
│                    ▼                                                     │
│               ┌────────────────────────────────────────────────────┐    │
│               │ ForecastChangeDetector compares to previous values │    │
│               │ Emit FORECAST_CHANGE if thresholds exceeded        │    │
│               └────────────────────────────────────────────────────┘    │
│                                                                          │
│  Total latency: ~3 seconds from file appearance to signal               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        File-Based Ingestion System                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐   │
│  │  ScheduleManager │─────▶│  S3FileDetector  │─────▶│   GRIB2Parser    │   │
│  │                  │      │                  │      │                  │   │
│  │ • Pre-computes   │      │ • HeadObject     │      │ • wgrib2/ecCodes │   │
│  │   filenames      │      │   polling        │      │ • Extract 13     │   │
│  │ • Manages        │      │ • Download       │      │   cities         │   │
│  │   windows        │      │ • Parse trigger  │      │ • 3 variables    │   │
│  └──────────────────┘      └──────────────────┘      └──────────────────┘   │
│           │                         │                         │              │
│           │                         │                         │              │
│           ▼                         ▼                         ▼              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                           EventBus                                    │   │
│  │  Events: DETECTION_WINDOW_START, FILE_DETECTED, FILE_CONFIRMED       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│           ┌────────────────────────┼────────────────────────┐                │
│           ▼                        ▼                        ▼                │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐       │
│  │ ApiFallbackPoller│    │ForecastChange    │    │ HybridWeather    │       │
│  │                  │    │   Detector       │    │   Controller     │       │
│  │ • 1s polling     │    │                  │    │                  │       │
│  │ • Open-Meteo     │    │ • Compare values │    │ • Mode switching │       │
│  │ • Stops on       │    │ • Thresholds     │    │ • Opportunity    │       │
│  │   FILE_CONFIRMED │    │ • Emit changes   │    │   detection      │       │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Schedule   │────▶│  Detection   │────▶│     S3       │────▶│    File      │
│   Manager    │     │   Window     │     │  HeadObject  │     │  Detected!   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                                                                      ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Forecast    │◀────│   Change     │◀────│  FILE_CONFIRM│◀────│   Download   │
│   Change     │     │  Detector    │     │    Event     │     │  & Parse     │
└──────┬───────┘     └──────────────┘     └──────────────┘     └──────────────┘
       │
       ▼
┌──────────────┐
│  Opportunity │
│   Detector   │
└──────────────┘
```

### Component Details

#### ScheduleManager

**Location**: [`src/weather/schedule-manager.ts`](../src/weather/schedule-manager.ts)

Manages model run schedules and detection windows.

```typescript
class ScheduleManager {
  // Pre-compute expected filename for a model cycle
  getExpectedFile(model: ModelType, cycleHour: number, runDate: Date): ExpectedFileInfo;
  
  // Calculate detection window timing
  calculateDetectionWindow(model: ModelType, cycleHour: number, runDate: Date): ModelRunSchedule;
  
  // Get upcoming runs for all models
  getUpcomingRuns(count: number): ModelRunSchedule[];
  
  // Start/stop monitoring
  start(): void;
  stop(): void;
}
```

#### S3FileDetector

**Location**: [`src/weather/s3-file-detector.ts`](../src/weather/s3-file-detector.ts)

Polls S3 buckets using HeadObject for fast file detection.

```typescript
class S3FileDetector {
  // Start detecting a specific file
  startDetection(expectedFile: ExpectedFileInfo, schedule: ModelRunSchedule): void;
  
  // Stop detection
  stopDetection(fileKey: string): void;
  stopAll(): void;
  
  // Get active detection count
  getActiveDetectionCount(): number;
}
```

**Key Features**:
- Uses AWS SDK HeadObject for existence checks (faster than ListObjects)
- 150ms poll interval (configurable)
- Anonymous credentials for public buckets
- Automatic download and parsing on detection

#### GRIB2Parser

**Location**: [`src/weather/grib2-parser.ts`](../src/weather/grib2-parser.ts)

Parses GRIB2 files using wgrib2 or ecCodes.

```typescript
class GRIB2Parser {
  // Parse a GRIB2 buffer
  parse(buffer: Buffer, options: ParseOptions): Promise<GRIBParseResult>;
  
  // Check if wgrib2 is available
  private checkWgrib2Available(): boolean;
  
  // Extract specific variables
  private parseWithWgrib2(filePath: string, options: ParseOptions): Promise<CityGRIBData[]>;
  private parseWithEcCodes(filePath: string, options: ParseOptions): Promise<CityGRIBData[]>;
}
```

**Extracted Variables**:
| Variable | GRIB Name | Level | Units |
|----------|-----------|-------|-------|
| Temperature | TMP | 2 m above ground | K |
| U Wind | UGRD | 10 m above ground | m/s |
| V Wind | VGRD | 10 m above ground | m/s |
| Total Precipitation | APCP | surface | kg/m² |

#### ApiFallbackPoller

**Location**: [`src/weather/api-fallback-poller.ts`](../src/weather/api-fallback-poller.ts)

Provides secondary data stream during detection windows.

```typescript
class ApiFallbackPoller {
  // Start fallback polling
  startPolling(window: DetectionWindow): void;
  
  // Stop polling (called when file confirmed)
  stopPolling(windowId: string): void;
  
  // Handle file confirmation
  private handleFileConfirmed(model: ModelType, cycleHour: number): void;
}
```

**Behavior**:
- Starts polling 10 minutes after expected publication time
- Polls Open-Meteo every 1 second
- Emits `API_DATA_RECEIVED` events with `confidence: 'LOW'`
- Stops immediately on `FILE_CONFIRMED`

#### ForecastChangeDetector

**Location**: [`src/weather/forecast-change-detector.ts`](../src/weather/forecast-change-detector.ts)

Detects significant forecast changes and emits events.

```typescript
class ForecastChangeDetector {
  // Process new data (file or API)
  processData(data: CityGRIBData[], model: ModelType, cycleHour: number, source: 'FILE' | 'API'): void;
  
  // Check if change exceeds threshold
  private checkThreshold(variable: VariableType, oldValue: number, newValue: number): boolean;
  
  // Emit FORECAST_CHANGE event
  private emitChange(cityId: string, variable: VariableType, change: ChangeDetails): void;
}
```

**Default Thresholds**:
| Variable | Threshold | Description |
|----------|-----------|-------------|
| Temperature | 0.5°C | Significant temperature change |
| Wind Speed | 2 kph | Significant wind change |
| Precipitation | 0.1 mm | Significant precipitation change |

### Integration with API Fallback

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Dual-Path Architecture                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PRIMARY PATH (File-Based)                    SECONDARY PATH (API)         │
│                                                                              │
│   ┌──────────────────┐                         ┌──────────────────┐        │
│   │  S3FileDetector  │                         │ ApiFallbackPoller│        │
│   │                  │                         │                  │        │
│   │ HeadObject poll  │                         │ Open-Meteo poll  │        │
│   │ 150ms interval   │                         │ 1000ms interval  │        │
│   └────────┬─────────┘                         └────────┬─────────┘        │
│            │                                            │                   │
│            ▼                                            ▼                   │
│   ┌──────────────────┐                         ┌──────────────────┐        │
│   │ FILE_CONFIRMED   │◀───────────────────────│ Stop polling     │        │
│   │ confidence: HIGH │    (stops fallback)    │ on confirmation  │        │
│   └────────┬─────────┘                         └──────────────────┘        │
│            │                                                                │
│            ▼                                                                │
│   ┌──────────────────┐                                                      │
│   │ ForecastChange   │                                                      │
│   │   Detector       │                                                      │
│   └────────┬─────────┘                                                      │
│            │                                                                │
│            ▼                                                                │
│   ┌──────────────────┐                                                      │
│   │ FORECAST_CHANGE  │                                                      │
│   │   Event          │                                                      │
│   └──────────────────┘                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

All configuration is done through environment variables in `.env`:

```bash
# =============================================================================
# FILE-BASED INGESTION CONFIGURATION
# =============================================================================

# Enable/disable file-based ingestion (default: true)
ENABLE_FILE_BASED_INGESTION=true

# S3 poll interval in milliseconds (default: 150)
# Lower = faster detection but more S3 requests
# Recommended: 100-250ms
S3_POLL_INTERVAL_MS=150

# Detection window buffer in minutes (default: 5)
# Start polling this many minutes before expected publication
DETECTION_WINDOW_BUFFER_MINUTES=5

# API fallback max duration in minutes (default: 5)
# How long to poll APIs if file not detected
API_FALLBACK_MAX_DURATION_MINUTES=5

# Forecast change thresholds
FORECAST_CHANGE_THRESHOLD_CELSIUS=0.5
FORECAST_CHANGE_THRESHOLD_WIND_KPH=2
FORECAST_CHANGE_THRESHOLD_PRECIP_MM=0.1
```

### Configuration in Code

**Location**: [`src/config.ts`](../src/config.ts)

```typescript
export interface Config {
  // File-based ingestion settings
  S3_POLL_INTERVAL_MS: number;
  DETECTION_WINDOW_BUFFER_MINUTES: number;
  API_FALLBACK_MAX_DURATION_MINUTES: number;
  FORECAST_CHANGE_THRESHOLD_CELSIUS: number;
  FORECAST_CHANGE_THRESHOLD_WIND_KPH: number;
  FORECAST_CHANGE_THRESHOLD_PRECIP_MM: number;
  ENABLE_FILE_BASED_INGESTION: boolean;
}
```

### Tuning Parameters

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `S3_POLL_INTERVAL_MS` | 150 | 100-250 | Lower = faster detection, higher S3 costs |
| `DETECTION_WINDOW_BUFFER_MINUTES` | 5 | 3-10 | Higher = earlier start, more polling time |
| `API_FALLBACK_MAX_DURATION_MINUTES` | 5 | 3-10 | Higher = longer API fallback window |
| `FORECAST_CHANGE_THRESHOLD_CELSIUS` | 0.5 | 0.1-2.0 | Lower = more sensitive to changes |

### Runtime Configuration

You can also configure the system at runtime:

```typescript
import { FileBasedIngestion } from './weather/file-based-ingestion.js';

const ingestion = new FileBasedIngestion({
  enabled: true,
  s3PollIntervalMs: 150,
  maxDetectionDurationMs: 45 * 60 * 1000, // 45 minutes
  awsRegion: 'us-east-1',
  publicBuckets: true,
});

ingestion.start();
```

---

## Operations

### Starting the System

The file-based ingestion system starts automatically when the bot starts:

```bash
npm run dev
```

Or manually:

```typescript
import { FileBasedIngestion } from './weather/index.js';

const ingestion = new FileBasedIngestion();
ingestion.start();
```

### Stopping the System

```typescript
ingestion.stop();
```

### Monitoring Status

```typescript
// Check if running
const isRunning = ingestion.getIsRunning();

// Get active detection windows
const windows = ingestion.getActiveWindows();

// Get active S3 detections
const count = ingestion.getActiveDetectionCount();

// Get upcoming model runs
const upcoming = ingestion.getUpcomingRuns(10);
```

### Manual Trigger

For testing or catching up on missed cycles:

```typescript
// Manually trigger detection for a specific cycle
await ingestion.triggerManualDetection('HRRR', 12, new Date());
```

### Logs

The system logs key events at `info` level:

```
[FileBasedIngestion] Starting file-based ingestion system
[ScheduleManager] Starting schedule monitoring
[S3FileDetector] Starting detection for HRRR 12Z: hrrr.20260201/conus/hrrr.t12z.wrfsfcf00.grib2
[S3FileDetector] File detected: hrrr.20260201/conus/hrrr.t12z.wrfsfcf00.grib2 (450ms latency, 15728640 bytes)
[GRIB2Parser] Parsed GRIB2 file in 180ms
[ForecastChangeDetector] Temperature change detected for New York City: 22.5°C → 23.2°C (+0.7°C)
```

Enable `debug` level for detailed polling logs:

```bash
LOG_LEVEL=debug
```

---

## Model Reference

### HRRR (High-Resolution Rapid Refresh)

**Coverage**: CONUS (Continental US)

| Attribute | Value |
|-----------|-------|
| Cycle Interval | 1 hour (00-23 UTC) |
| First File Delay | 30-60 minutes |
| Detection File | f00 (analysis) |
| Spatial Resolution | 3 km |
| File Size | ~15-20 MB |
| S3 Bucket | `noaa-hrrr-pds` |
| Path Template | `hrrr.{YYYYMMDD}/conus/hrrr.t{HH}z.wrfsfcf{FF}.grib2` |

**Example URL**:
```
https://noaa-hrrr-pds.s3.amazonaws.com/hrrr.20260201/conus/hrrr.t12z.wrfsfcf00.grib2
```

### RAP (Rapid Refresh)

**Coverage**: CONUS + Southern Canada

| Attribute | Value |
|-----------|-------|
| Cycle Interval | 1 hour (00-23 UTC) |
| First File Delay | 30-50 minutes |
| Detection File | f00 (analysis) |
| Spatial Resolution | 13 km |
| File Size | ~10-15 MB |
| S3 Bucket | `noaa-rap-pds` |
| Path Template | `rap.{YYYYMMDD}/rap.t{HH}z.awp130f{FF}.grib2` |

**Example URL**:
```
https://noaa-rap-pds.s3.amazonaws.com/rap.20260201/rap.t12z.awp130f00.grib2
```

### GFS (Global Forecast System)

**Coverage**: Global

| Attribute | Value |
|-----------|-------|
| Cycle Interval | 6 hours (00, 06, 12, 18 UTC) |
| First File Delay | 3-5 minutes |
| Detection File | f003 (3-hour forecast) |
| Spatial Resolution | 0.25° |
| File Size | ~50-100 MB |
| S3 Bucket | `noaa-gfs-pds` |
| Path Template | `gfs.{YYYYMMDD}/{HH}/atmos/gfs.t{HH}z.pgrb2.0p25.f{FFF}` |

**Example URL**:
```
https://noaa-gfs-pds.s3.amazonaws.com/gfs.20260201/12/atmos/gfs.t12z.pgrb2.0p25.f003
```

### Model Schedule Matrix

| Model | Cycles (UTC) | First File Delay | Detection File | Bucket | Coverage |
|-------|--------------|------------------|----------------|--------|----------|
| HRRR | 00-23 (hourly) | 30-60 min | f00 | noaa-hrrr-pds | CONUS only |
| RAP | 00-23 (hourly) | 30-50 min | f00 | noaa-rap-pds | CONUS + S. Canada |
| GFS | 00, 06, 12, 18 | 3-5 min | f003 | noaa-gfs-pds | Global |

---

## City Coverage

### City-to-Model Mapping

| # | City | Primary Model | Fallback Models | Latitude | Longitude |
|---|------|---------------|-----------------|----------|-----------|
| 1 | New York City | HRRR | RAP, GFS | 40.7128°N | 74.0060°W |
| 2 | Washington DC | HRRR | RAP, GFS | 38.9072°N | 77.0369°W |
| 3 | Chicago | HRRR | RAP, GFS | 41.8781°N | 87.6298°W |
| 4 | Los Angeles | HRRR | RAP, GFS | 34.0522°N | 118.2437°W |
| 5 | Miami | HRRR | RAP, GFS | 25.7617°N | 80.1918°W |
| 6 | Dallas | HRRR | RAP, GFS | 32.7767°N | 96.7970°W |
| 7 | Seattle | HRRR | RAP, GFS | 47.6062°N | 122.3321°W |
| 8 | Atlanta | HRRR | RAP, GFS | 33.7490°N | 84.3880°W |
| 9 | Toronto | GFS | RAP, HRRR | 43.6532°N | 79.3832°W |
| 10 | London | GFS | RAP | 51.5074°N | 0.1278°W |
| 11 | Seoul | GFS | RAP | 37.5665°N | 126.9780°E |
| 12 | Ankara | GFS | RAP | 39.9334°N | 32.8597°E |
| 13 | Buenos Aires | GFS | RAP | 34.6037°S | 58.3816°W |

### Coverage by Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Model Coverage                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  HRRR (CONUS)                    RAP (CONUS + Canada)                        │
│  ┌─────────────────────┐        ┌─────────────────────────┐                 │
│  │ NYC, DC, CHI, LA    │        │ NYC, DC, CHI, LA, MIA   │                 │
│  │ MIA, DAL, SEA, ATL  │        │ DAL, SEA, ATL, Toronto  │                 │
│  └─────────────────────┘        └─────────────────────────┘                 │
│                                                                              │
│  GFS (Global)                                                                │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │ All 13 cities including international:                  │                │
│  │ London, Seoul, Ankara, Buenos Aires                     │                │
│  └─────────────────────────────────────────────────────────┘                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Common Issues

#### High Detection Latency

**Symptoms**: Detection taking >1 second

**Causes & Solutions**:
1. **Network latency to S3**
   - Check: `ping s3.us-east-1.amazonaws.com`
   - Solution: Ensure server is in us-east-1 region

2. **Poll interval too high**
   - Check: `S3_POLL_INTERVAL_MS` setting
   - Solution: Reduce to 150ms or lower

3. **AWS SDK cold start**
   - Normal for first detection
   - Subsequent detections should be faster

#### File Not Detected

**Symptoms**: Detection window expires without file detection

**Causes & Solutions**:
1. **Incorrect expected time**
   - Check model schedule in logs
   - Verify UTC timezone

2. **S3 path incorrect**
   - Check: `ScheduleManager.getExpectedFile()` output
   - Verify path template matches NOAA format

3. **File actually delayed**
   - Check NOAA status: https://status.noaa.gov/
   - API fallback should activate automatically

#### GRIB2 Parse Failures

**Symptoms**: File detected but parsing fails

**Causes & Solutions**:
1. **wgrib2 not installed**
   - Check: `which wgrib2`
   - Install: `apt-get install wgrib2` (Ubuntu/Debian)

2. **Corrupt download**
   - Check file size in logs
   - System will retry automatically

3. **Missing variables**
   - Check GRIB2 file contents
   - Some cycles may have incomplete data

#### API Fallback Not Stopping

**Symptoms**: API polling continues after file detection

**Causes & Solutions**:
1. **EventBus not connected**
   - Check: `EventBus.getInstance()` singleton
   - Verify event listeners are registered

2. **Wrong window ID**
   - Check window ID matching in logs
   - Ensure model/cycleHour match

### Debug Commands

```bash
# Check wgrib2 installation
wgrib2 --version

# Test S3 access
curl -I https://noaa-hrrr-pds.s3.amazonaws.com/

# View recent logs
tail -f logs/weather-ingestion.log | grep "FileBasedIngestion"

# Run latency benchmark
npm run benchmark:latency

# Run file ingestion tests
npm run test:file-ingestion
```

### Decision Tree

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Troubleshooting Decision Tree                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  File not being detected?                                                    │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────┐                                                │
│  │ Check detection window  │                                                │
│  │ timing in logs          │                                                │
│  └────────────┬────────────┘                                                │
│               │                                                              │
│     ┌─────────┴─────────┐                                                    │
│     ▼                   ▼                                                    │
│  Window open?      Window closed?                                             │
│       │                │                                                     │
│       ▼                ▼                                                     │
│  Check S3         Check model                                                │
│  connectivity     schedule                                                   │
│       │                │                                                     │
│       ▼                ▼                                                     │
│  Can access       Time correct?                                              │
│  noaa-hrrr-pds?        │                                                     │
│       │           ┌────┴────┐                                                │
│       │           ▼         ▼                                                │
│       │          Yes        No                                               │
│       │           │         │                                                │
│       │           ▼         ▼                                                │
│       │      Check path   Fix UTC                                            │
│       │      template     timezone                                           │
│       │           │                                                          │
│       └───────────┘                                                          │
│                   │                                                          │
│                   ▼                                                          │
│            Check NOAA                                                        │
│            status page                                                       │
│                   │                                                          │
│                   ▼                                                          │
│            File delayed?                                                     │
│         ┌─────────┴─────────┐                                                │
│         ▼                   ▼                                                │
│        Yes                  No                                               │
│         │                   │                                                │
│         ▼                   ▼                                                │
│    Wait for file       Contact support                                       │
│    (API fallback       (possible bug)                                        │
│     active)                                                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Additional Resources

- [NOAA HRRR Documentation](https://rapidrefresh.noaa.gov/hrrr/)
- [NOAA RAP Documentation](https://rapidrefresh.noaa.gov/)
- [NOAA GFS Documentation](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast)
- [GRIB2 Format Specification](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/)
- [wgrib2 Documentation](https://www.cpc.ncep.noaa.gov/products/wesley/wgrib2/)
