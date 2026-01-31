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
    logLevel: string;

    // City priority settings
    highPriorityCities: string[];
    highPriorityPollIntervalMs: number;  // Poll interval for high priority cities (default: 3000ms)

    // Guaranteed outcome detection
    certaintySigmaThreshold: number;      // Std deviations for certainty (default: 3.0)
    guaranteedPositionMultiplier: number; // Position size multiplier for guaranteed trades

    // Speed arbitrage settings
    skipPriceCheck: boolean;              // Skip market price reaction check on forecast changes (trade immediately)

    // Webhook-based forecast detection settings
    TOMORROW_WEBHOOK_SECRET: string;      // Secret for validating Tomorrow.io webhooks
    FETCH_MODE_TIMEOUT_MINUTES: number;   // Hard timeout for FETCH_MODE (default: 10)
    NO_CHANGE_EXIT_MINUTES: number;       // Exit FETCH_MODE after no changes for N minutes (default: 5)
    PROVIDER_POLL_INTERVAL_MS: number;    // Interval between provider polls in FETCH_MODE (default: 5000)
    IDLE_POLL_INTERVAL_MINUTES: number;   // Interval for IDLE mode polling (default: 5)
    USE_WEBHOOK_MODE: boolean;            // Enable webhook-based forecast detection (default: true)
}

function getEnvVarOptional(name: string, defaultValue: string): string {
    return process.env[name] || defaultValue;
}

function getEnvVarBool(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true';
}

export function getEnvVarNumber(name: string, defaultValue: number): number {
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
    maxPositionSize: getEnvVarNumber('MAX_POSITION_SIZE', 10),
    minEdgeThreshold: getEnvVarNumber('MIN_EDGE_THRESHOLD', 0.10),
    pollIntervalMs: getEnvVarNumber('POLL_INTERVAL_MS', 60000), // 1 minute
    forecastPollIntervalMs: getEnvVarNumber('FORECAST_POLL_INTERVAL_MS', 12000),
    logLevel: getEnvVarOptional('LOG_LEVEL', 'info'),

    // City priority settings
    highPriorityCities: getEnvVarOptional('HIGH_PRIORITY_CITIES', '').split(',').map(c => c.trim()).filter(c => c.length > 0),
    highPriorityPollIntervalMs: getEnvVarNumber('HIGH_PRIORITY_POLL_INTERVAL_MS', 6000), // 6 seconds

    // Guaranteed outcome detection
    certaintySigmaThreshold: getEnvVarNumber('CERTAINTY_SIGMA_THRESHOLD', 3.0), // 3 std devs = 99.87% certain
    guaranteedPositionMultiplier: getEnvVarNumber('GUARANTEED_POSITION_MULTIPLIER', 2.0), // 2x position for guaranteed

    // Speed arbitrage settings
    skipPriceCheck: getEnvVarBool('SKIP_PRICE_CHECK', false), // Skip market price reaction check on forecast changes

    // Webhook-based forecast detection settings
    TOMORROW_WEBHOOK_SECRET: getEnvVarOptional('TOMORROW_WEBHOOK_SECRET', ''),
    FETCH_MODE_TIMEOUT_MINUTES: getEnvVarNumber('FETCH_MODE_TIMEOUT_MINUTES', 10),
    NO_CHANGE_EXIT_MINUTES: getEnvVarNumber('NO_CHANGE_EXIT_MINUTES', 5),
    PROVIDER_POLL_INTERVAL_MS: getEnvVarNumber('PROVIDER_POLL_INTERVAL_MS', 5000),
    IDLE_POLL_INTERVAL_MINUTES: getEnvVarNumber('IDLE_POLL_INTERVAL_MINUTES', 5),
    USE_WEBHOOK_MODE: getEnvVarBool('USE_WEBHOOK_MODE', true),
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
