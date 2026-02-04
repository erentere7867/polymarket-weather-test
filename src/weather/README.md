# Weather Module

This module provides comprehensive weather data services for the Polymarket arbitrage bot, including file-based ingestion from NOAA S3 buckets, API-based providers, and a unified interface for weather data retrieval.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File-Based Ingestion](#file-based-ingestion)
3. [API Providers](#api-providers)
4. [Weather Service](#weather-service)
5. [Type Definitions](#type-definitions)
6. [Usage Examples](#usage-examples)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Weather Module Architecture                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        WeatherService                                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │   │
│  │  │ NOAA Client  │  │  Provider    │  │  FileBasedIngestion      │   │   │
│  │  │              │  │  Manager     │  │  (S3 File Detection)     │   │   │
│  │  │ • NWS API    │  │              │  │                          │   │   │
│  │  │ • US only    │  │ • Round-robin│  │ • HRRR/RAP/GFS models    │   │   │
│  │  │ • Free       │  │ • Rate limit │  │ • Sub-5s latency         │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                           EventBus                                    │   │
│  │  Events: FORECAST_CHANGED, FILE_DETECTED, FILE_CONFIRMED, etc.       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     Opportunity Detector                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File-Based Ingestion

The file-based ingestion system provides **sub-5-second latency** weather forecast detection by monitoring NOAA S3 buckets directly for model file appearance.

### Components

#### FileBasedIngestion

**File**: [`file-based-ingestion.ts`](file-based-ingestion.ts)

Main controller that coordinates all file-based ingestion components.

```typescript
import { FileBasedIngestion } from './index.js';

const ingestion = new FileBasedIngestion({
  enabled: true,
  s3PollIntervalMs: 150,
  maxDetectionDurationMs: 45 * 60 * 1000,
  awsRegion: 'us-east-1',
  publicBuckets: true,
});

// Start the system
ingestion.start();

// Check status
console.log(ingestion.getIsRunning());  // true
console.log(ingestion.getActiveDetectionCount());  // 0

// Stop the system
ingestion.stop();
```

**Methods**:

| Method | Description |
|--------|-------------|
| `start()` | Start the file-based ingestion system |
| `stop()` | Stop the system and cleanup |
| `getIsRunning()` | Check if system is running |
| `getActiveWindows()` | Get active detection windows |
| `getActiveDetectionCount()` | Get number of active S3 detections |
| `getUpcomingRuns(count)` | Get upcoming model runs |
| `triggerManualDetection(model, cycleHour, runDate)` | Manually trigger detection |
| `getCityModelConfig(cityName)` | Get model config for a city |

#### ScheduleManager

**File**: [`schedule-manager.ts`](schedule-manager.ts)

Pre-computes expected filenames and manages detection windows for all NOAA models.

```typescript
import { ScheduleManager } from './index.js';

const scheduleManager = new ScheduleManager({
  detectionWindowLeadMinutes: 5,
  detectionWindowDurationMinutes: 45,
  fallbackWindowLeadMinutes: 10,
  fallbackWindowDurationMinutes: 30,
});

// Start monitoring
scheduleManager.start();

// Get expected file info
const expectedFile = scheduleManager.getExpectedFile('HRRR', 12, new Date());
console.log(expectedFile);
// {
//   bucket: 'noaa-hrrr-pds',
//   key: 'hrrr.20260201/conus/hrrr.t12z.wrfsfcf00.grib2',
//   model: 'HRRR',
//   cycleHour: 12,
//   forecastHour: 0,
//   fullUrl: 'https://noaa-hrrr-pds.s3.amazonaws.com/...'
// }

// Get detection window
const schedule = scheduleManager.calculateDetectionWindow('HRRR', 12, new Date());
console.log(schedule.detectionWindowStart);  // Date object
console.log(schedule.detectionWindowEnd);    // Date object

// Get upcoming runs
const upcoming = scheduleManager.getUpcomingRuns(10);
```

**Model Schedules**:

| Model | Cycles | First File Delay | Detection File | Bucket |
|-------|--------|------------------|----------------|--------|
| HRRR | Hourly (00-23) | 30-60 min | f00 | noaa-hrrr-pds |
| RAP | Hourly (00-23) | 30-50 min | f00 | noaa-rap-pds |
| GFS | 6-hourly (00,06,12,18) | 3-5 min | f003 | noaa-gfs-pds |

#### S3FileDetector

**File**: [`s3-file-detector.ts`](s3-file-detector.ts)

Polls S3 buckets using HeadObject for fast file detection.

```typescript
import { S3FileDetector } from './index.js';

const detector = new S3FileDetector({
  pollIntervalMs: 150,
  maxDetectionDurationMs: 45 * 60 * 1000,
  downloadTimeoutMs: 30 * 1000,
  region: 'us-east-1',
  publicBuckets: true,
});

// Start detection for a specific file
detector.startDetection(expectedFile, schedule);

// Stop detection
detector.stopDetection(fileKey);
detector.stopAll();

// Get status
console.log(detector.getActiveDetectionCount());
```

**Events** (via EventBus):

| Event | Payload | Description |
|-------|---------|-------------|
| `FILE_DETECTED` | `FileDetectedData` | File detected in S3 |
| `FILE_CONFIRMED` | `FileConfirmedData` | File downloaded and parsed |

#### GRIB2Parser

**File**: [`grib2-parser.ts`](grib2-parser.ts)

Parses GRIB2 files using wgrib2 or ecCodes.

```typescript
import { GRIB2Parser } from './index.js';

const parser = new GRIB2Parser();

// Parse a GRIB2 buffer
const result = await parser.parse(buffer, {
  model: 'HRRR',
  cycleHour: 12,
  forecastHour: 0,
});

console.log(result.cityData);
// [
//   {
//     cityName: 'New York City',
//     coordinates: { lat: 40.7128, lon: -74.006 },
//     temperatureC: 22.5,
//     temperatureF: 72.5,
//     windSpeedMps: 3.5,
//     windSpeedMph: 7.8,
//     windDirection: 180,
//     precipitationRateMmHr: 0,
//     totalPrecipitationMm: 0,
//     totalPrecipitationIn: 0,
//   },
//   ...
// ]
```

**Requirements**:
- `wgrib2` must be installed on the system
- Falls back to ecCodes if wgrib2 is not available

#### ApiFallbackPoller

**File**: [`api-fallback-poller.ts`](api-fallback-poller.ts)

Provides secondary data stream during detection windows using Open-Meteo API.

```typescript
import { ApiFallbackPoller } from './index.js';

const poller = new ApiFallbackPoller({
  pollIntervalMs: 1000,
  maxDurationMinutes: 5,
  useCache: false,
});

// Start polling for a detection window
poller.startPolling(detectionWindow);

// Stop polling
poller.stopPolling(windowId);
```

**Behavior**:
- Starts polling 10 minutes after expected publication time
- Polls Open-Meteo every 1 second
- Emits `API_DATA_RECEIVED` events with `confidence: 'LOW'`
- Stops immediately on `FILE_CONFIRMED`

#### ForecastChangeDetector

**File**: [`forecast-change-detector.ts`](forecast-change-detector.ts)

Detects significant forecast changes and emits `FORECAST_CHANGE` events.

```typescript
import { ForecastChangeDetector } from './index.js';

const detector = new ForecastChangeDetector({
  temperatureThresholdCelsius: 0.5,
  windSpeedThresholdKph: 2,
  precipitationThresholdMm: 0.1,
  emitSubThreshold: false,
});

// Process new data
detector.processData(cityData, 'HRRR', 12, 'FILE');
```

**Default Thresholds**:

| Variable | Threshold | Description |
|----------|-----------|-------------|
| Temperature | 0.5°C | ~1°F change |
| Wind Speed | 2 kph | ~1.2 mph change |
| Precipitation | 0.1 mm | ~0.004 inch change |

---

## API Providers

### NOAAClient

**File**: [`noaa-client.ts`](noaa-client.ts)

Fetches weather data from NOAA National Weather Service API.

```typescript
import { NOAAClient } from './index.js';

const client = new NOAAClient();

// Get hourly forecast
const forecast = await client.getHourlyForecast({
  lat: 40.7128,
  lon: -74.006,
});

console.log(forecast.hourly[0]);
// {
//   timestamp: Date,
//   temperatureF: 72,
//   temperatureC: 22.2,
//   humidity: 65,
//   windSpeedMph: 8,
//   probabilityOfPrecipitation: 10,
//   ...
// }
```

**Features**:
- Free, no API key required
- US locations only
- Authoritative government data

### OpenWeatherClient

**File**: [`openweather-client.ts`](openweather-client.ts)

Fetches weather data from OpenWeatherMap API.

```typescript
import { OpenWeatherClient } from './index.js';

const client = new OpenWeatherClient('your-api-key');

const forecast = await client.getHourlyForecast({
  lat: 51.5074,
  lon: -0.1278,
});
```

**Features**:
- Requires API key
- International coverage
- Paid tier for extended forecasts

### OpenMeteoClient

**File**: [`openmeteo-client.ts`](openmeteo-client.ts)

Fetches weather data from Open-Meteo API (free, no API key).

```typescript
import { OpenMeteoClient } from './index.js';

const client = new OpenMeteoClient();

const forecast = await client.getHourlyForecast({
  lat: 37.5665,
  lon: 126.9780,
});
```

**Features**:
- Free, no API key required
- Global coverage
- Used as fallback provider

### WeatherProviderManager

**File**: [`provider-manager.ts`](provider-manager.ts)

Manages multiple weather providers with round-robin rotation and rate limiting.

```typescript
import { WeatherProviderManager } from './index.js';

const manager = new WeatherProviderManager();

// Get next available provider
const provider = manager.getProvider();

// Wait for rate limit
await manager.waitForRateLimit(provider.name);
await manager.enforceRateLimit(provider.name);

// Record success/failure
manager.recordSuccess(provider.name);
manager.recordError(provider.name, statusCode);
```

---

## Weather Service

**File**: [`index.ts`](index.ts)

Main entry point for weather data retrieval. Routes US locations to NOAA, others to provider manager.

```typescript
import { WeatherService, findCity, KNOWN_CITIES } from './index.js';

const weatherService = new WeatherService();

// Get forecast for coordinates
const forecast = await weatherService.getForecast(
  { lat: 40.7128, lon: -74.006 },
  'US'
);

// Find city by name
const city = findCity('NYC');
console.log(city);
// {
//   name: 'New York City',
//   aliases: ['NYC', 'New York', 'NY', 'Manhattan'],
//   coordinates: { lat: 40.7128, lon: -74.006 },
//   timezone: 'America/New_York',
//   country: 'US',
// }

// Get all known cities
console.log(KNOWN_CITIES);  // Array of 13 cities
```

---

## Type Definitions

**File**: [`types.ts`](types.ts)

### Core Types

```typescript
// Coordinates
interface Coordinates {
  lat: number;
  lon: number;
}

// Hourly forecast
interface HourlyForecast {
  timestamp: Date;
  temperatureF: number;
  temperatureC: number;
  feelsLikeF?: number;
  feelsLikeC?: number;
  humidity?: number;
  windSpeedMph?: number;
  windDirection?: string;
  probabilityOfPrecipitation: number;
  precipitationType?: 'rain' | 'snow' | 'sleet' | 'mixed' | 'none';
  snowfallInches?: number;
  shortForecast?: string;
  isDaytime: boolean;
}

// Daily forecast
interface DailyForecast {
  date: Date;
  highF: number;
  lowF: number;
  highC: number;
  lowC: number;
  probabilityOfPrecipitation: number;
  snowfallInches?: number;
  shortForecast?: string;
}

// Complete weather data
interface WeatherData {
  location: Coordinates;
  locationName?: string;
  fetchedAt: Date;
  source: string;
  hourly: HourlyForecast[];
  daily?: DailyForecast[];
}
```

### File Ingestion Types

```typescript
// NOAA Model Types
type ModelType = 'HRRR' | 'RAP' | 'GFS';

// Expected S3 file information
interface ExpectedFileInfo {
  bucket: string;
  key: string;
  model: ModelType;
  cycleHour: number;
  forecastHour: number;
  fullUrl: string;
}

// City data from GRIB2
interface CityGRIBData {
  cityName: string;
  coordinates: Coordinates;
  temperatureC: number;
  temperatureF: number;
  windSpeedMps: number;
  windSpeedMph: number;
  windDirection: number;
  precipitationRateMmHr: number;
  totalPrecipitationMm: number;
  totalPrecipitationIn: number;
}

// File detection result
interface FileDetectionResult {
  expectedFile: ExpectedFileInfo;
  detectedAt: Date;
  detectionLatencyMs: number;
  downloadUrl: string;
  fileSize: number;
  lastModified: Date;
}

// File confirmed data
interface FileConfirmedData {
  model: ModelType;
  cycleHour: number;
  forecastHour: number;
  runDate: Date;
  cityData: CityGRIBData[];
  timestamp: Date;
  source: 'FILE';
  detectionLatencyMs: number;
  downloadTimeMs: number;
  parseTimeMs: number;
  fileSize: number;
}
```

### City Configuration

```typescript
// City location
interface CityLocation {
  name: string;
  aliases: string[];
  coordinates: Coordinates;
  timezone: string;
  country: string;
}

// City to model mapping
interface CityModelConfig {
  cityName: string;
  primaryModel: ModelType;
  fallbackModels: ModelType[];
}

// Predefined cities (13 total)
const KNOWN_CITIES: CityLocation[] = [
  { name: 'New York City', aliases: ['NYC', 'New York', 'NY', 'Manhattan'], coordinates: { lat: 40.7128, lon: -74.006 }, timezone: 'America/New_York', country: 'US' },
  { name: 'Washington DC', aliases: ['Washington D.C.', 'DC', 'Washington'], coordinates: { lat: 38.9072, lon: -77.0369 }, timezone: 'America/New_York', country: 'US' },
  { name: 'Chicago', aliases: ['CHI'], coordinates: { lat: 41.8781, lon: -87.6298 }, timezone: 'America/Chicago', country: 'US' },
  { name: 'Los Angeles', aliases: ['LA', 'L.A.'], coordinates: { lat: 34.0522, lon: -118.2437 }, timezone: 'America/Los_Angeles', country: 'US' },
  { name: 'Miami', aliases: [], coordinates: { lat: 25.7617, lon: -80.1918 }, timezone: 'America/New_York', country: 'US' },
  { name: 'Dallas', aliases: ['DFW'], coordinates: { lat: 32.7767, lon: -96.797 }, timezone: 'America/Chicago', country: 'US' },
  { name: 'Seattle', aliases: [], coordinates: { lat: 47.6062, lon: -122.3321 }, timezone: 'America/Los_Angeles', country: 'US' },
  { name: 'Atlanta', aliases: ['ATL'], coordinates: { lat: 33.749, lon: -84.388 }, timezone: 'America/New_York', country: 'US' },
  { name: 'Toronto', aliases: [], coordinates: { lat: 43.6532, lon: -79.3832 }, timezone: 'America/Toronto', country: 'CA' },
  { name: 'London', aliases: [], coordinates: { lat: 51.5074, lon: -0.1278 }, timezone: 'Europe/London', country: 'UK' },
  { name: 'Seoul', aliases: [], coordinates: { lat: 37.5665, lon: 126.978 }, timezone: 'Asia/Seoul', country: 'KR' },
  { name: 'Ankara', aliases: [], coordinates: { lat: 39.9334, lon: 32.8597 }, timezone: 'Europe/Istanbul', country: 'TR' },
  { name: 'Buenos Aires', aliases: [], coordinates: { lat: -34.6037, lon: -58.3816 }, timezone: 'America/Argentina/Buenos_Aires', country: 'AR' },
];

// City model assignments
const CITY_MODEL_CONFIGS: CityModelConfig[] = [
  // CONUS cities - HRRR primary
  { cityName: 'New York City', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Washington DC', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Chicago', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Los Angeles', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Miami', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Dallas', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Seattle', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  { cityName: 'Atlanta', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
  // International cities - GFS primary
  { cityName: 'Toronto', primaryModel: 'GFS', fallbackModels: ['RAP', 'HRRR'] },
  { cityName: 'London', primaryModel: 'GFS', fallbackModels: ['RAP'] },
  { cityName: 'Seoul', primaryModel: 'GFS', fallbackModels: ['RAP'] },
  { cityName: 'Ankara', primaryModel: 'GFS', fallbackModels: ['RAP'] },
  { cityName: 'Buenos Aires', primaryModel: 'GFS', fallbackModels: ['RAP'] },
];
```

---

## Usage Examples

### Basic Weather Fetch

```typescript
import { WeatherService, findCity } from './weather/index.js';

const weatherService = new WeatherService();

// Get forecast for a city
const city = findCity('NYC');
if (city) {
  const forecast = await weatherService.getForecast(
    city.coordinates,
    city.country
  );
  
  console.log(`Current temp in ${city.name}: ${forecast.hourly[0].temperatureF}°F`);
}
```

### File-Based Ingestion

```typescript
import { FileBasedIngestion } from './weather/index.js';
import { EventBus } from './realtime/event-bus.js';

const eventBus = EventBus.getInstance();
const ingestion = new FileBasedIngestion();

// Listen for forecast changes
eventBus.on('FORECAST_CHANGE', (event) => {
  if (event.type === 'FORECAST_CHANGE') {
    console.log(`Forecast change for ${event.payload.cityName}:`);
    console.log(`  ${event.payload.variable}: ${event.payload.oldValue} → ${event.payload.newValue}`);
  }
});

// Start ingestion
ingestion.start();

// Get upcoming runs
const upcoming = ingestion.getUpcomingRuns(5);
console.log('Upcoming model runs:', upcoming);
```

### Manual Detection Trigger

```typescript
import { FileBasedIngestion } from './weather/index.js';

const ingestion = new FileBasedIngestion();
ingestion.start();

// Manually trigger detection for testing
await ingestion.triggerManualDetection('HRRR', 12, new Date());
```

### Custom Provider Usage

```typescript
import { 
  NOAAClient, 
  OpenMeteoClient, 
  WeatherProviderManager 
} from './weather/index.js';

// Use specific provider
const noaa = new NOAAClient();
const forecast = await noaa.getHourlyForecast({ lat: 40.71, lon: -74.01 });

// Or use provider manager for automatic fallback
const manager = new WeatherProviderManager();
const provider = manager.getProvider();
const result = await provider.getHourlyForecast({ lat: 51.51, lon: -0.13 });
```

---

## Configuration

All weather module configuration is done through environment variables:

```bash
# File-based ingestion
ENABLE_FILE_BASED_INGESTION=true
S3_POLL_INTERVAL_MS=150
DETECTION_WINDOW_BUFFER_MINUTES=5
API_FALLBACK_MAX_DURATION_MINUTES=5

# Forecast thresholds
FORECAST_CHANGE_THRESHOLD_CELSIUS=0.5
FORECAST_CHANGE_THRESHOLD_WIND_KPH=2
FORECAST_CHANGE_THRESHOLD_PRECIP_MM=0.1

# API keys
OPENWEATHER_API_KEY=your_key_here
TOMORROW_API_KEY=your_key_here
```

See [`.env.example`](../../.env.example) for all available options.

---

## Additional Documentation

- [File Ingestion Guide](../../docs/FILE_INGESTION.md) - Detailed file-based ingestion documentation
- [Operations Runbook](../../docs/OPERATIONS.md) - Deployment and troubleshooting
- [Latency Budget](../../docs/LATENCY_BUDGET.md) - Performance requirements
