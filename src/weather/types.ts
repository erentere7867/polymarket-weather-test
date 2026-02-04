/**
 * Weather data types - unified interface for all weather providers
 */

export interface Coordinates {
    lat: number;
    lon: number;
}

export interface TemperatureForecast {
    timestamp: Date;
    temperatureF: number;
    temperatureC: number;
    feelsLikeF?: number;
    feelsLikeC?: number;
}

export interface PrecipitationForecast {
    timestamp: Date;
    probabilityOfPrecipitation: number; // 0-100
    precipitationType?: 'rain' | 'snow' | 'sleet' | 'mixed';
    snowfallInches?: number;
    rainfallInches?: number;
}

export interface HourlyForecast {
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
    snowfallInches?: number; // Estimated or actual hourly snowfall
    shortForecast?: string;
    isDaytime: boolean;
}

export interface DailyForecast {
    date: Date;
    highF: number;
    lowF: number;
    highC: number;
    lowC: number;
    probabilityOfPrecipitation: number;
    snowfallInches?: number;
    shortForecast?: string;
}

export interface WeatherData {
    location: Coordinates;
    locationName?: string;
    fetchedAt: Date;
    source: string;
    hourly: HourlyForecast[];
    daily?: DailyForecast[];
}

/**
 * Weather metric types that can be compared to market outcomes
 */
export type WeatherMetricType =
    | 'temperature_high'
    | 'temperature_low'
    | 'snowfall'
    | 'precipitation_probability'
    | 'temperature_at_time';

export interface WeatherMetric {
    type: WeatherMetricType;
    value: number;
    unit: string;
    confidence: number; // 0-1, how confident we are in this forecast
    timestamp: Date;
}

/**
 * Location mapping for common cities in weather markets
 */
export interface CityLocation {
    name: string;
    aliases: string[];
    coordinates: Coordinates;
    timezone: string;
    country: string;
}

export const KNOWN_CITIES: CityLocation[] = [
    {
        name: 'New York City',
        aliases: ['NYC', 'New York', 'NY', 'Manhattan'],
        coordinates: { lat: 40.7128, lon: -74.0060 },
        timezone: 'America/New_York',
        country: 'US',
    },
    {
        name: 'Washington DC',
        aliases: ['Washington D.C.', 'DC', 'Washington'],
        coordinates: { lat: 38.9072, lon: -77.0369 },
        timezone: 'America/New_York',
        country: 'US',
    },
    {
        name: 'Chicago',
        aliases: ['CHI'],
        coordinates: { lat: 41.8781, lon: -87.6298 },
        timezone: 'America/Chicago',
        country: 'US',
    },
    {
        name: 'Los Angeles',
        aliases: ['LA', 'L.A.'],
        coordinates: { lat: 34.0522, lon: -118.2437 },
        timezone: 'America/Los_Angeles',
        country: 'US',
    },
    {
        name: 'Miami',
        aliases: [],
        coordinates: { lat: 25.7617, lon: -80.1918 },
        timezone: 'America/New_York',
        country: 'US',
    },
    {
        name: 'Dallas',
        aliases: ['DFW'],
        coordinates: { lat: 32.7767, lon: -96.7970 },
        timezone: 'America/Chicago',
        country: 'US',
    },
    {
        name: 'Seattle',
        aliases: [],
        coordinates: { lat: 47.6062, lon: -122.3321 },
        timezone: 'America/Los_Angeles',
        country: 'US',
    },
    {
        name: 'Atlanta',
        aliases: ['ATL'],
        coordinates: { lat: 33.7490, lon: -84.3880 },
        timezone: 'America/New_York',
        country: 'US',
    },
    {
        name: 'Toronto',
        aliases: [],
        coordinates: { lat: 43.6532, lon: -79.3832 },
        timezone: 'America/Toronto',
        country: 'CA',
    },
    {
        name: 'London',
        aliases: [],
        coordinates: { lat: 51.5074, lon: -0.1278 },
        timezone: 'Europe/London',
        country: 'UK',
    },
    {
        name: 'Seoul',
        aliases: [],
        coordinates: { lat: 37.5665, lon: 126.9780 },
        timezone: 'Asia/Seoul',
        country: 'KR',
    },
    {
        name: 'Ankara',
        aliases: [],
        coordinates: { lat: 39.9334, lon: 32.8597 },
        timezone: 'Europe/Istanbul',
        country: 'TR',
    },
    {
        name: 'Buenos Aires',
        aliases: [],
        coordinates: { lat: -34.6037, lon: -58.3816 },
        timezone: 'America/Argentina/Buenos_Aires',
        country: 'AR',
    },
];

/**
 * Find city coordinates from name or alias
 */
// Build a lookup map for O(1) city lookups
const CITY_LOOKUP_MAP: Map<string, CityLocation> = new Map();

// Initialize the lookup map
(function initCityLookup() {
    for (const city of KNOWN_CITIES) {
        // Index by name
        CITY_LOOKUP_MAP.set(city.name.toLowerCase().trim(), city);
        // Index by aliases
        for (const alias of city.aliases) {
            CITY_LOOKUP_MAP.set(alias.toLowerCase().trim(), city);
        }
    }
})();

export function findCity(query: string): CityLocation | undefined {
    return CITY_LOOKUP_MAP.get(query.toLowerCase().trim());
}

/**
 * Interface for Weather Providers
 */
export interface IWeatherProvider {
    name: string;
    isConfigured(): boolean;
    getHourlyForecast(coords: Coordinates): Promise<WeatherData>;
}

// ============================================================================
// NOAA Model File Ingestion Types
// ============================================================================

/**
 * NOAA Model Types
 */
export type ModelType = 'HRRR' | 'RAP' | 'GFS' | 'ECMWF';

/**
 * Detection window status
 */
export type DetectionWindowStatus = 'PENDING' | 'ACTIVE' | 'DETECTED' | 'CONFIRMED' | 'TIMEOUT';

/**
 * Detection window for a model cycle
 */
export interface DetectionWindow {
    model: ModelType;
    cycleHour: number;
    runDate: Date;
    windowStart: Date;
    windowEnd: Date;
    expectedFile: ExpectedFileInfo;
    status: DetectionWindowStatus;
    createdAt: Date;
}

/**
 * Expected S3 file information
 */
export interface ExpectedFileInfo {
    bucket: string;
    key: string;
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    fullUrl: string;
    region?: string;
}

/**
 * City data extracted from GRIB2 file
 */
export interface CityGRIBData {
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

/**
 * Data emitted when a file is confirmed (downloaded and parsed)
 */
export interface FileConfirmedData {
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

/**
 * Data emitted when a file is first detected
 */
export interface FileDetectedData {
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    bucket: string;
    key: string;
    detectedAt: Date;
    detectionLatencyMs: number;
    fileSize: number;
    lastModified: Date;
}

/**
 * City to model mapping configuration
 */
export interface CityModelConfig {
    cityName: string;
    primaryModel: ModelType;
    fallbackModels: ModelType[];
}

/**
 * Model configuration for schedule management
 */
export interface ModelConfig {
    cycleIntervalHours: number;
    firstFileDelayMinutes: { min: number; max: number };
    detectionFile: number;
    bucket: string;
    pathTemplate: string;
    region?: string;
    detectionWindowDurationMinutes?: number;
}

/**
 * NOAA Model Run Schedule Information
 */
export interface ModelRunSchedule {
    model: ModelType;
    cycleHour: number;
    runDate: Date;
    expectedPublishTime: Date;
    detectionWindowStart: Date;
    detectionWindowEnd: Date;
    fallbackWindowStart: Date;
    fallbackWindowEnd: Date;
}

/**
 * File detection result from S3
 */
export interface FileDetectionResult {
    expectedFile: ExpectedFileInfo;
    detectedAt: Date;
    detectionLatencyMs: number;
    downloadUrl: string;
    fileSize: number;
    lastModified: Date;
}

/**
 * GRIB2 Variable Identifiers
 */
export enum GRIBVariable {
    TEMP_2M = 'TMP:2 m above ground',
    WIND_U_10M = 'UGRD:10 m above ground',
    WIND_V_10M = 'VGRD:10 m above ground',
    PRECIP_RATE = 'PRATE:surface',
    TOTAL_PRECIP = 'APCP:surface',
}

/**
 * Parsed GRIB2 data for a specific location
 */
export interface ParsedGRIBData {
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    validTime: Date;
    gridPoints: Map<string, GridPointData>;
    metadata: {
        fileSize: number;
        downloadTimeMs: number;
        parseTimeMs: number;
    };
}

/**
 * Weather data at a specific grid point
 */
export interface GridPointData {
    coordinates: Coordinates;
    temperatureC: number;
    windSpeedMps: number;
    windDirection: number;
    precipitationRateMmHr: number;
    totalPrecipitationMm: number;
}

/**
 * City-to-model mapping for 13 supported cities
 * HRRR: High-resolution, best for CONUS cities
 * RAP: Rapid refresh, good for all cities
 * GFS: Global, fallback for international cities
 */
export const CITY_MODEL_CONFIGS: CityModelConfig[] = [
    // CONUS cities - HRRR primary
    { cityName: 'New York City', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Washington DC', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Chicago', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Los Angeles', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Miami', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Dallas', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Seattle', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    { cityName: 'Atlanta', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
    // International cities - ECMWF primary (Dual Model Arbitration)
    { cityName: 'Toronto', primaryModel: 'GFS', fallbackModels: ['RAP', 'HRRR'] }, // Keep GFS/RAP for Toronto as it's close to US
    { cityName: 'London', primaryModel: 'ECMWF', fallbackModels: ['GFS'] },
    { cityName: 'Seoul', primaryModel: 'ECMWF', fallbackModels: ['GFS'] },
    { cityName: 'Ankara', primaryModel: 'ECMWF', fallbackModels: ['GFS'] },
    { cityName: 'Buenos Aires', primaryModel: 'ECMWF', fallbackModels: ['GFS'] },
];

/**
 * Get model config for a city
 */
export function getCityModelConfig(cityName: string): CityModelConfig | undefined {
    return CITY_MODEL_CONFIGS.find(c => c.cityName.toLowerCase() === cityName.toLowerCase());
}
