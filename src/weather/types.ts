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
    source: 'noaa' | 'openweather';
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
}

export const KNOWN_CITIES: CityLocation[] = [
    {
        name: 'New York City',
        aliases: ['NYC', 'New York', 'NY', 'Manhattan'],
        coordinates: { lat: 40.7128, lon: -74.0060 },
        timezone: 'America/New_York',
    },
    {
        name: 'Washington DC',
        aliases: ['Washington D.C.', 'DC', 'Washington'],
        coordinates: { lat: 38.9072, lon: -77.0369 },
        timezone: 'America/New_York',
    },
    {
        name: 'Chicago',
        aliases: ['CHI'],
        coordinates: { lat: 41.8781, lon: -87.6298 },
        timezone: 'America/Chicago',
    },
    {
        name: 'Los Angeles',
        aliases: ['LA', 'L.A.'],
        coordinates: { lat: 34.0522, lon: -118.2437 },
        timezone: 'America/Los_Angeles',
    },
    {
        name: 'Miami',
        aliases: [],
        coordinates: { lat: 25.7617, lon: -80.1918 },
        timezone: 'America/New_York',
    },
    {
        name: 'Dallas',
        aliases: ['DFW'],
        coordinates: { lat: 32.7767, lon: -96.7970 },
        timezone: 'America/Chicago',
    },
    {
        name: 'Seattle',
        aliases: [],
        coordinates: { lat: 47.6062, lon: -122.3321 },
        timezone: 'America/Los_Angeles',
    },
    {
        name: 'Atlanta',
        aliases: ['ATL'],
        coordinates: { lat: 33.7490, lon: -84.3880 },
        timezone: 'America/New_York',
    },
    {
        name: 'Toronto',
        aliases: [],
        coordinates: { lat: 43.6532, lon: -79.3832 },
        timezone: 'America/Toronto',
    },
    {
        name: 'London',
        aliases: [],
        coordinates: { lat: 51.5074, lon: -0.1278 },
        timezone: 'Europe/London',
    },
    {
        name: 'Seoul',
        aliases: [],
        coordinates: { lat: 37.5665, lon: 126.9780 },
        timezone: 'Asia/Seoul',
    },
    {
        name: 'Ankara',
        aliases: [],
        coordinates: { lat: 39.9334, lon: 32.8597 },
        timezone: 'Europe/Istanbul',
    },
    {
        name: 'Buenos Aires',
        aliases: [],
        coordinates: { lat: -34.6037, lon: -58.3816 },
        timezone: 'America/Argentina/Buenos_Aires',
    },
];

/**
 * Find city coordinates from name or alias
 */
export function findCity(query: string): CityLocation | undefined {
    const normalizedQuery = query.toLowerCase().trim();

    return KNOWN_CITIES.find(city => {
        if (city.name.toLowerCase() === normalizedQuery) return true;
        return city.aliases.some(alias => alias.toLowerCase() === normalizedQuery);
    });
}
