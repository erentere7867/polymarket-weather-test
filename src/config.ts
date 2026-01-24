import dotenv from 'dotenv';

dotenv.config();

export interface Config {
    // Polymarket
    privateKey: string;
    chainId: number;
    clobHost: string;
    gammaHost: string;

    // Weather APIs
    openWeatherApiKey: string;
    noaaHost: string;

    // Bot settings
    simulationMode: boolean;
    maxPositionSize: number;
    minEdgeThreshold: number;
    pollIntervalMs: number;
    logLevel: string;
}

function getEnvVar(name: string, defaultValue?: string): string {
    const value = process.env[name];
    if (!value && defaultValue === undefined) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value || defaultValue!;
}

function getEnvVarOptional(name: string, defaultValue: string): string {
    return process.env[name] || defaultValue;
}

function getEnvVarBool(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true';
}

function getEnvVarNumber(name: string, defaultValue: number): number {
    const value = process.env[name];
    if (!value) return defaultValue;
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return defaultValue;
    return parsed;
}

export const config: Config = {
    // Polymarket configuration
    privateKey: getEnvVar('PRIVATE_KEY', ''),
    chainId: 137, // Polygon mainnet
    clobHost: 'https://clob.polymarket.com',
    gammaHost: 'https://gamma-api.polymarket.com',

    // Weather APIs
    openWeatherApiKey: getEnvVarOptional('OPENWEATHER_API_KEY', ''),
    noaaHost: 'https://api.weather.gov',

    // Bot settings
    simulationMode: getEnvVarBool('SIMULATION_MODE', true),
    maxPositionSize: getEnvVarNumber('MAX_POSITION_SIZE', 10),
    minEdgeThreshold: getEnvVarNumber('MIN_EDGE_THRESHOLD', 0.10),
    pollIntervalMs: getEnvVarNumber('POLL_INTERVAL_MS', 300000), // 5 minutes
    logLevel: getEnvVarOptional('LOG_LEVEL', 'info'),
};

export function validateConfig(): void {
    if (!config.simulationMode && !config.privateKey) {
        throw new Error('PRIVATE_KEY is required when not in simulation mode');
    }
}
