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

    // File-based ingestion settings
    S3_POLL_INTERVAL_MS: number;                  // S3 poll interval (default: 150ms)
    DETECTION_WINDOW_BUFFER_MINUTES: number;      // Buffer before expected publication (default: 5)
    API_FALLBACK_MAX_DURATION_MINUTES: number;    // Max API polling duration (default: 5)
    FORECAST_CHANGE_THRESHOLD_CELSIUS: number;    // Temperature change threshold (default: 0.5)
    FORECAST_CHANGE_THRESHOLD_WIND_KPH: number;   // Wind speed change threshold (default: 2)
    FORECAST_CHANGE_THRESHOLD_PRECIP_MM: number;  // Precipitation change threshold (default: 0.1)
    ENABLE_FILE_BASED_INGESTION: boolean;         // Enable file-based ingestion (default: true)

    // =====================================
    // NEW: Cross-Market Arbitrage Settings
    // =====================================
    ENABLE_CROSS_MARKET_ARBITRAGE: boolean;       // Enable cross-market arbitrage detection (default: true)
    MIN_CROSS_MARKET_CORRELATION: number;         // Minimum correlation to exploit (default: 0.60)
    MAX_LAG_EXPLOITATION_MINUTES: number;         // Maximum lag to exploit (default: 300)
    CROSS_MARKET_CONFIDENCE_MULTIPLIER: number;   // Confidence multiplier for cross-market trades (default: 0.85)

    // =====================================
    // NEW: Market Impact Model Settings
    // =====================================
    ENABLE_MARKET_IMPACT_MODEL: boolean;          // Enable market impact estimation (default: true)
    MAX_MARKET_IMPACT_THRESHOLD: number;          // Maximum acceptable market impact (default: 0.02 = 2%)
    MARKET_IMPACT_CONSTANT_LOW: number;           // Impact constant for liquid markets (default: 0.3)
    MARKET_IMPACT_CONSTANT_MEDIUM: number;        // Impact constant for average markets (default: 0.8)
    MARKET_IMPACT_CONSTANT_HIGH: number;          // Impact constant for illiquid markets (default: 1.5)
    ENABLE_POSITION_SCALING: boolean;             // Enable position scaling for large orders (default: true)
    POSITION_SCALE_THRESHOLD: number;             // Position size threshold for scaling (default: 100)

    // =====================================
    // NEW: Adaptive Detection Window Settings
    // =====================================
    ENABLE_ADAPTIVE_DETECTION_WINDOWS: boolean;   // Enable adaptive detection windows (default: true)
    ADAPTIVE_WINDOW_MIN_OBSERVATIONS: number;     // Min observations for adaptive adjustment (default: 5)
    ADAPTIVE_WINDOW_STD_DEV_FACTOR: number;       // Std dev factor for window adjustment (default: 1.0)
    EARLY_DETECTION_CONFIDENCE_THRESHOLD: number; // Confidence threshold for early detection (default: 0.7)
    EARLY_DETECTION_MAX_DURATION_MS: number;      // Max duration for early detection mode (default: 300000 = 5min)

    // =====================================
    // NEW: Performance Tracking Settings
    // =====================================
    ENABLE_PERFORMANCE_TRACKING: boolean;         // Enable detailed performance tracking (default: true)
    PERFORMANCE_LOG_INTERVAL_MS: number;          // Interval for performance logging (default: 300000 = 5min)
    TRACK_PNL_BY_DATA_SOURCE: boolean;            // Track PnL by data source (default: true)
    TRACK_CROSS_MARKET_PERFORMANCE: boolean;      // Track cross-market vs single-market (default: true)
    MAX_IMPACT_ESTIMATE_HISTORY: number;          // Max history for impact estimates (default: 100)
    MAX_CONFIDENCE_HISTORY: number;               // Max history for confidence scores (default: 100)
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
    minEdgeThreshold: getEnvVarNumber('MIN_EDGE_THRESHOLD', 0.05),
    pollIntervalMs: getEnvVarNumber('POLL_INTERVAL_MS', 60000), // 1 minute
    forecastPollIntervalMs: getEnvVarNumber('FORECAST_POLL_INTERVAL_MS', 12000),
    logLevel: getEnvVarOptional('LOG_LEVEL', 'info'),

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

    // File-based ingestion settings
    S3_POLL_INTERVAL_MS: getEnvVarNumber('S3_POLL_INTERVAL_MS', 150),
    DETECTION_WINDOW_BUFFER_MINUTES: getEnvVarNumber('DETECTION_WINDOW_BUFFER_MINUTES', 5),
    API_FALLBACK_MAX_DURATION_MINUTES: getEnvVarNumber('API_FALLBACK_MAX_DURATION_MINUTES', 5),
    FORECAST_CHANGE_THRESHOLD_CELSIUS: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_CELSIUS', 0.5),
    FORECAST_CHANGE_THRESHOLD_WIND_KPH: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_WIND_KPH', 2),
    FORECAST_CHANGE_THRESHOLD_PRECIP_MM: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_PRECIP_MM', 0.1),
    ENABLE_FILE_BASED_INGESTION: getEnvVarBool('ENABLE_FILE_BASED_INGESTION', true),

    // =====================================
    // NEW: Cross-Market Arbitrage Settings
    // =====================================
    ENABLE_CROSS_MARKET_ARBITRAGE: getEnvVarBool('ENABLE_CROSS_MARKET_ARBITRAGE', true),
    MIN_CROSS_MARKET_CORRELATION: getEnvVarNumber('MIN_CROSS_MARKET_CORRELATION', 0.60),
    MAX_LAG_EXPLOITATION_MINUTES: getEnvVarNumber('MAX_LAG_EXPLOITATION_MINUTES', 300),
    CROSS_MARKET_CONFIDENCE_MULTIPLIER: getEnvVarNumber('CROSS_MARKET_CONFIDENCE_MULTIPLIER', 0.85),

    // =====================================
    // NEW: Market Impact Model Settings
    // =====================================
    ENABLE_MARKET_IMPACT_MODEL: getEnvVarBool('ENABLE_MARKET_IMPACT_MODEL', true),
    MAX_MARKET_IMPACT_THRESHOLD: getEnvVarNumber('MAX_MARKET_IMPACT_THRESHOLD', 0.02),
    MARKET_IMPACT_CONSTANT_LOW: getEnvVarNumber('MARKET_IMPACT_CONSTANT_LOW', 0.3),
    MARKET_IMPACT_CONSTANT_MEDIUM: getEnvVarNumber('MARKET_IMPACT_CONSTANT_MEDIUM', 0.8),
    MARKET_IMPACT_CONSTANT_HIGH: getEnvVarNumber('MARKET_IMPACT_CONSTANT_HIGH', 1.5),
    ENABLE_POSITION_SCALING: getEnvVarBool('ENABLE_POSITION_SCALING', true),
    POSITION_SCALE_THRESHOLD: getEnvVarNumber('POSITION_SCALE_THRESHOLD', 100),

    // =====================================
    // NEW: Adaptive Detection Window Settings
    // =====================================
    ENABLE_ADAPTIVE_DETECTION_WINDOWS: getEnvVarBool('ENABLE_ADAPTIVE_DETECTION_WINDOWS', true),
    ADAPTIVE_WINDOW_MIN_OBSERVATIONS: getEnvVarNumber('ADAPTIVE_WINDOW_MIN_OBSERVATIONS', 5),
    ADAPTIVE_WINDOW_STD_DEV_FACTOR: getEnvVarNumber('ADAPTIVE_WINDOW_STD_DEV_FACTOR', 1.0),
    EARLY_DETECTION_CONFIDENCE_THRESHOLD: getEnvVarNumber('EARLY_DETECTION_CONFIDENCE_THRESHOLD', 0.7),
    EARLY_DETECTION_MAX_DURATION_MS: getEnvVarNumber('EARLY_DETECTION_MAX_DURATION_MS', 300000),

    // =====================================
    // NEW: Performance Tracking Settings
    // =====================================
    ENABLE_PERFORMANCE_TRACKING: getEnvVarBool('ENABLE_PERFORMANCE_TRACKING', true),
    PERFORMANCE_LOG_INTERVAL_MS: getEnvVarNumber('PERFORMANCE_LOG_INTERVAL_MS', 300000),
    TRACK_PNL_BY_DATA_SOURCE: getEnvVarBool('TRACK_PNL_BY_DATA_SOURCE', true),
    TRACK_CROSS_MARKET_PERFORMANCE: getEnvVarBool('TRACK_CROSS_MARKET_PERFORMANCE', true),
    MAX_IMPACT_ESTIMATE_HISTORY: getEnvVarNumber('MAX_IMPACT_ESTIMATE_HISTORY', 100),
    MAX_CONFIDENCE_HISTORY: getEnvVarNumber('MAX_CONFIDENCE_HISTORY', 100),
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
