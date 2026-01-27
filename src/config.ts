import dotenv from 'dotenv';

dotenv.config();

export interface PolymarketCredentials {
    apiKey: string;
    secret: string;
    passphrase: string;
}

export interface Config {
    // Polymarket
    privateKey: string;
    polymarketApiKey: string;
    polymarketSecret: string;
    polymarketPassphrase: string;
    chainId: number;
    polygonRpcUrl: string;
    usdcContractAddress: string;
    clobHost: string;
    gammaHost: string;
    dataApiHost: string;

    // Weather APIs
    openWeatherApiKey: string;
    tomorrowApiKey: string;
    weatherApiKey: string;
    weatherbitApiKey: string;
    visualCrossingApiKey: string;
    meteosourceApiKey: string;
    noaaHost: string;

    // Bot settings
    simulationMode: boolean;
    maxPositionSize: number;
    minEdgeThreshold: number;
    pollIntervalMs: number;
    forecastPollIntervalMs: number;
    multiSourcePollIntervalMs: number;
    logLevel: string;

    // Guaranteed outcome detection
    certaintySigmaThreshold: number;      // Std deviations for certainty (default: 3.0)
    guaranteedPositionMultiplier: number; // Position size multiplier for guaranteed trades
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
    privateKey: getEnvVarOptional('POLYMARKET_PRIVATE_KEY', '') || getEnvVarOptional('PRIVATE_KEY', ''),
    polymarketApiKey: getEnvVarOptional('POLYMARKET_API_KEY', ''),
    polymarketSecret: getEnvVarOptional('POLYMARKET_SECRET', ''),
    polymarketPassphrase: getEnvVarOptional('POLYMARKET_PASSPHRASE', ''),
    chainId: 137, // Polygon mainnet
    polygonRpcUrl: getEnvVarOptional('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    usdcContractAddress: getEnvVarOptional('USDC_CONTRACT_ADDRESS', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'),
    clobHost: 'https://clob.polymarket.com',
    gammaHost: 'https://gamma-api.polymarket.com',
    dataApiHost: 'https://data-api.polymarket.com',

    // Weather APIs
    openWeatherApiKey: getEnvVarOptional('OPENWEATHER_API_KEY', ''),
    tomorrowApiKey: getEnvVarOptional('TOMORROW_API_KEY', ''),
    weatherApiKey: getEnvVarOptional('WEATHERAPI_KEY', ''),
    weatherbitApiKey: getEnvVarOptional('WEATHERBIT_API_KEY', ''),
    visualCrossingApiKey: getEnvVarOptional('VISUALCROSSING_API_KEY', ''),
    meteosourceApiKey: getEnvVarOptional('METEOSOURCE_API_KEY', ''),
    noaaHost: 'https://api.weather.gov',

    // Bot settings
    simulationMode: getEnvVarBool('SIMULATION_MODE', false),
    maxPositionSize: getEnvVarNumber('MAX_POSITION_SIZE', 50),
    minEdgeThreshold: getEnvVarNumber('MIN_EDGE_THRESHOLD', 0.02), // 2% edge (AGGRESSIVE)
    pollIntervalMs: getEnvVarNumber('POLL_INTERVAL_MS', 300000), // 5 minutes
    forecastPollIntervalMs: getEnvVarNumber('FORECAST_POLL_INTERVAL_MS', 10000), // 10 seconds for speed arbitrage
    multiSourcePollIntervalMs: getEnvVarNumber('MULTISOURCE_POLL_INTERVAL_MS', 5000), // 5 seconds default
    logLevel: getEnvVarOptional('LOG_LEVEL', 'info'),

    // Guaranteed outcome detection
    certaintySigmaThreshold: getEnvVarNumber('CERTAINTY_SIGMA_THRESHOLD', 1.5), // 1.5 std devs (AGGRESSIVE)
    guaranteedPositionMultiplier: getEnvVarNumber('GUARANTEED_POSITION_MULTIPLIER', 2.0), // 2x position for guaranteed
};

/**
 * Check if we have pre-configured API credentials
 */
export function hasApiCredentials(): boolean {
    return !!(config.polymarketApiKey && config.polymarketSecret && config.polymarketPassphrase);
}

/**
 * Get pre-configured credentials if available
 */
export function getApiCredentials(): PolymarketCredentials | null {
    if (!hasApiCredentials()) return null;
    return {
        apiKey: config.polymarketApiKey,
        secret: config.polymarketSecret,
        passphrase: config.polymarketPassphrase,
    };
}

export function validateConfig(): void {
    if (!config.simulationMode && !config.privateKey) {
        throw new Error('POLYMARKET_PRIVATE_KEY is required when not in simulation mode');
    }
}
