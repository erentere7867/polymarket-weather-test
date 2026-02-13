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
    SPEED_ARBITRAGE_MODE: boolean;        // First-model-wins: all cities monitored via GFS+ECMWF, US cities also HRRR+RAP, trade on ANY model change
    SPEED_ARB_REQUIRE_THRESHOLD_CROSSING: boolean;  // Require threshold crossing for speed arbitrage (default: false)
    SPEED_ARB_MIN_CROSSING_DISTANCE: number;        // Minimum distance from threshold to consider crossing valid (default: 0.5)

    // Webhook-based forecast detection settings
    TOMORROW_WEBHOOK_SECRET: string;      // Secret for validating Tomorrow.io webhooks
    FETCH_MODE_TIMEOUT_MINUTES: number;   // Hard timeout for FETCH_MODE (default: 10)
    NO_CHANGE_EXIT_MINUTES: number;       // Exit FETCH_MODE after no changes for N minutes (default: 5)
    PROVIDER_POLL_INTERVAL_MS: number;    // Interval between provider polls in FETCH_MODE (default: 5000)
    IDLE_POLL_INTERVAL_MINUTES: number;   // Interval for IDLE mode polling (default: 5)
    USE_WEBHOOK_MODE: boolean;            // Enable webhook-based forecast detection (default: true)

    // wgrib2 path configuration
    WGRIB2_PATH: string;                  // Custom path to wgrib2 binary (default: auto-detect)

    // File-based ingestion settings
    S3_POLL_INTERVAL_MS: number;                  // S3 poll interval (default: 150ms)
    DETECTION_WINDOW_BUFFER_MINUTES: number;      // Buffer before expected publication (default: 5)
    API_FALLBACK_MAX_DURATION_MINUTES: number;    // Max API polling duration (default: 5)
    FORECAST_CHANGE_THRESHOLD_CELSIUS: number;    // Temperature change threshold (default: 0.5)
    FORECAST_CHANGE_THRESHOLD_WIND_KPH: number;   // Wind speed change threshold (default: 2)
    FORECAST_CHANGE_THRESHOLD_PRECIP_MM: number;  // Precipitation change threshold (default: 0.1)
    ENABLE_FILE_BASED_INGESTION: boolean;         // Enable file-based ingestion (default: true)
    RAP_HRRR_TEMP_TOLERANCE: number;              // Temperature tolerance for RAP-HRRR confirmation (°F, default: 2.0)

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

    // =====================================
    // NEW: Dynamic Kelly Sizing Settings
    // =====================================
    KELLY_FRACTION_HIGH: number;                  // Half-Kelly for sigma > 2.0 (default: 0.50)
    KELLY_FRACTION_MEDIUM: number;                // Quarter-Kelly for 0.5 < sigma < 2.0 (default: 0.25)
    KELLY_FRACTION_LOW: number;                   // 1/8-Kelly for low confidence (default: 0.125)
    KELLY_FRACTION_GUARANTEED: number;            // 3/4-Kelly for guaranteed trades (default: 0.75)
    
    // =====================================
    // NEW: Edge Decay Settings
    // =====================================
    EDGE_DECAY_HALF_LIFE_MS: number;              // Half-life for edge decay (default: 60000 = 1min)
    EDGE_DECAY_MAX_AGE_MS: number;                // Max age for trading (default: 180000 = 3min)
    URGENCY_SIZE_MULTIPLIER: number;              // Max size boost for fresh signals (default: 1.5)
    
    // =====================================
    // NEW: Regime-Based Exit Settings
    // =====================================
    ENABLE_REGIME_BASED_EXITS: boolean;           // Enable regime-based exit management (default: true)
    REGIME_TAKE_PROFIT_TRENDING: number;          // TP in trending markets (default: 0.15)
    REGIME_STOP_LOSS_TRENDING: number;            // SL in trending markets (default: -0.20)
    REGIME_TAKE_PROFIT_RANGING: number;           // TP in ranging markets (default: 0.08)
    REGIME_STOP_LOSS_RANGING: number;             // SL in ranging markets (default: -0.10)
    ENABLE_PARTIAL_EXITS: boolean;                // Enable partial exit logic (default: true)
    PARTIAL_EXIT_THRESHOLD: number;               // Profit % to trigger partial exit (default: 0.05)
    PARTIAL_EXIT_PERCENT: number;                 // % of position to exit (default: 0.50)
    
    // =====================================
    // NEW: Kelly Portfolio Heat Management
    // =====================================
    MAX_PORTFOLIO_EXPOSURE: number;               // Max % of portfolio in positions (default: 0.50)
    MAX_KELLY_HEAT: number;                       // Max sum of Kelly fractions (default: 0.30)
    MIN_CASH_RESERVE: number;                     // Minimum % cash reserve (default: 0.10)
    CONCENTRATION_FACTOR: number;                 // Bonus for high-edge opportunities (default: 1.5)

    // =====================================
    // NEW: Strategy Orchestrator Settings
    // =====================================
    ENABLE_STRATEGY_ORCHESTRATOR: boolean;        // Enable multi-strategy orchestration
    TARGET_WIN_RATE: number;                      // Target win rate (default: 0.80)
    MIN_WIN_RATE_ADJUSTMENT: number;              // Min win rate before adjusting (default: 0.50)
    MAX_DAILY_TRADES: number;                     // Max trades per day (default: 50)
    MAX_DAILY_LOSS_PERCENT: number;               // Max daily loss % (default: 0.05)
    COMPOUND_RESET_DAYS: number;                  // Days before resetting compound base (default: 30)
    
    // Strategy weights
    STRATEGY_WEIGHT_CERTAINTY: number;            // Certainty arbitrage weight
    STRATEGY_WEIGHT_CONFIDENCE: number;           // Confidence compression weight
    STRATEGY_WEIGHT_CROSS_MARKET: number;         // Cross-market lag weight
    STRATEGY_WEIGHT_TIME_DECAY: number;           // Time decay weight
    STRATEGY_WEIGHT_DIVERGENCE: number;           // Model divergence weight
    
    // Certainty Arbitrage
    CERTAINTY_SIGMA_THRESHOLD_BASE: number;       // Base sigma threshold (default: 3.0)
    CERTAINTY_DAYS_TO_EVENT_MAX: number;          // Max days to event (default: 3)
    CERTAINTY_MIN_EDGE: number;                   // Min edge for certainty trades
    CERTAINTY_ONLY_MODE: boolean;                 // Only trade guaranteed outcomes (default: false)
    
    // Cross-Market Lag
    CROSS_MARKET_MIN_CORRELATION: number;         // Min correlation (default: 0.60)
    CROSS_MARKET_MAX_LAG_SECONDS: number;         // Max lag to exploit (default: 300)
    CROSS_MARKET_REENTRY_COOLDOWN_MINUTES: number; // Reentry cooldown (default: 10)
    
    // Early Trigger / Anticipation System
    ENABLE_EARLY_TRIGGER: boolean;                // Enable early trigger mode (default: true)
    EARLY_TRIGGER_MINUTES_BEFORE: number;         // Minutes before expected publication (default: 2)
    EARLY_TRIGGER_AGGRESSIVE_POLL_MS: number;     // Poll interval in early trigger (default: 25)

    // =====================================
    // NEW: Transaction Costs & Safety Margins
    // =====================================
    POLYMARKET_FEE_RATE: number;                  // 1% typical Polymarket fee (default: 0.01)
    SAFETY_MARGIN_HIGH_CONFIDENCE: number;        // 1% for 3σ+ trades (default: 0.01)
    SAFETY_MARGIN_MEDIUM_CONFIDENCE: number;      // 1.5% for 2σ+ trades (default: 0.015)
    SAFETY_MARGIN_LOW_CONFIDENCE: number;         // 2% for lower confidence trades (default: 0.02)
    BID_ASK_SPREAD_ESTIMATE: number;              // 1% typical spread cost (default: 0.01)
    MIN_ADJUSTED_EDGE_THRESHOLD: number;          // Minimum adjusted edge to trade (default: 0.02 = 2%)

    // =====================================
    // NEW: Drawdown Kill Switch Settings
    // =====================================
    DRAWDOWN_DAILY_LOSS_LIMIT: number;            // 5% daily loss limit (default: 0.05)
    DRAWDOWN_MAX_DRAWDOWN_LIMIT: number;          // 15% max drawdown from peak (default: 0.15)
    DRAWDOWN_CONSECUTIVE_LOSSES: number;          // Halt after N consecutive losses (default: 5)
    DRAWDOWN_COOLDOWN_HOURS: number;              // Cooldown hours after trigger (default: 24)
    DRAWDOWN_MIN_TRADES_BEFORE_KILL: number;      // Min trades before kill switch activates (default: 3)

    // =====================================
    // NEW: Model Bias Correction Settings
    // =====================================
    MODEL_BIAS_CORRECTION_ENABLED: boolean;       // Enable bias correction for model forecasts (default: true)
    MODEL_HORIZON_WEIGHTING_ENABLED: boolean;     // Enable horizon-aware model weighting (default: true)
    MODEL_ENSEMBLE_SPREAD_MULTIPLIER: number;     // How much spread affects variance (default: 0.5)

    // =====================================
    // NEW: Late-Trade Detection Settings
    // =====================================
    LATE_TRADE_PRICE_VELOCITY_THRESHOLD: number;  // 2% price move in 5 min = late
    LATE_TRADE_EDGE_DECAY_FACTOR: number;         // Reduce edge when price moving against us
    LATE_TRADE_MIN_TIME_SINCE_FORECAST: number;   // 30 seconds max freshness

    // =====================================
    // NEW: Liquidity Filtering Settings
    // =====================================
    MIN_ORDER_BOOK_DEPTH_USD: number;             // Minimum $1000 liquidity
    MAX_BID_ASK_SPREAD: number;                   // 3% max spread
    MIN_AVAILABLE_LIQUIDITY_SHARES: number;       // Minimum shares available

    // =====================================
    // NEW: Latency Tracking Settings
    // =====================================
    LATENCY_TRACKING_ENABLED: boolean;            // Enable latency tracking (default: true)
    LATENCY_LOG_ALL_TRACES: boolean;              // Log all traces or just slow ones (default: false)
    LATENCY_SLOW_TRACE_THRESHOLD_MS: number;      // Threshold for slow trace warning (default: 5000)
    LATENCY_STATS_WINDOW_SIZE: number;            // Number of traces to keep for stats (default: 100)
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
    SPEED_ARBITRAGE_MODE: getEnvVarBool('SPEED_ARBITRAGE_MODE', true), // First-model-wins mode
    SPEED_ARB_REQUIRE_THRESHOLD_CROSSING: getEnvVarBool('SPEED_ARB_REQUIRE_THRESHOLD_CROSSING', false), // DISABLED - capture more signals
    SPEED_ARB_MIN_CROSSING_DISTANCE: getEnvVarNumber('SPEED_ARB_MIN_CROSSING_DISTANCE', 0.5), // Min distance from threshold

    // Webhook-based forecast detection settings
    TOMORROW_WEBHOOK_SECRET: getEnvVarOptional('TOMORROW_WEBHOOK_SECRET', ''),
    FETCH_MODE_TIMEOUT_MINUTES: getEnvVarNumber('FETCH_MODE_TIMEOUT_MINUTES', 10),
    NO_CHANGE_EXIT_MINUTES: getEnvVarNumber('NO_CHANGE_EXIT_MINUTES', 5),
    PROVIDER_POLL_INTERVAL_MS: getEnvVarNumber('PROVIDER_POLL_INTERVAL_MS', 5000),
    IDLE_POLL_INTERVAL_MINUTES: getEnvVarNumber('IDLE_POLL_INTERVAL_MINUTES', 5),
    USE_WEBHOOK_MODE: getEnvVarBool('USE_WEBHOOK_MODE', true),

    // wgrib2 path configuration
    WGRIB2_PATH: getEnvVarOptional('WGRIB2_PATH', ''),  // Empty string means auto-detect

    // File-based ingestion settings
    S3_POLL_INTERVAL_MS: getEnvVarNumber('S3_POLL_INTERVAL_MS', 150),
    DETECTION_WINDOW_BUFFER_MINUTES: getEnvVarNumber('DETECTION_WINDOW_BUFFER_MINUTES', 5),
    API_FALLBACK_MAX_DURATION_MINUTES: getEnvVarNumber('API_FALLBACK_MAX_DURATION_MINUTES', 5),
    FORECAST_CHANGE_THRESHOLD_CELSIUS: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_CELSIUS', 0.5),
    FORECAST_CHANGE_THRESHOLD_WIND_KPH: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_WIND_KPH', 2),
    FORECAST_CHANGE_THRESHOLD_PRECIP_MM: getEnvVarNumber('FORECAST_CHANGE_THRESHOLD_PRECIP_MM', 0.1),
    ENABLE_FILE_BASED_INGESTION: getEnvVarBool('ENABLE_FILE_BASED_INGESTION', true),
    RAP_HRRR_TEMP_TOLERANCE: getEnvVarNumber('RAP_HRRR_TEMP_TOLERANCE', 2.0),

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

    // =====================================
    // NEW: Dynamic Kelly Sizing Settings
    // =====================================
    KELLY_FRACTION_HIGH: getEnvVarNumber('KELLY_FRACTION_HIGH', 0.50),
    KELLY_FRACTION_MEDIUM: getEnvVarNumber('KELLY_FRACTION_MEDIUM', 0.25),
    KELLY_FRACTION_LOW: getEnvVarNumber('KELLY_FRACTION_LOW', 0.125),
    KELLY_FRACTION_GUARANTEED: getEnvVarNumber('KELLY_FRACTION_GUARANTEED', 0.75),

    // =====================================
    // NEW: Edge Decay Settings
    // =====================================
    EDGE_DECAY_HALF_LIFE_MS: getEnvVarNumber('EDGE_DECAY_HALF_LIFE_MS', 60000),
    EDGE_DECAY_MAX_AGE_MS: getEnvVarNumber('EDGE_DECAY_MAX_AGE_MS', 180000),
    URGENCY_SIZE_MULTIPLIER: getEnvVarNumber('URGENCY_SIZE_MULTIPLIER', 1.5),

    // =====================================
    // NEW: Regime-Based Exit Settings
    // =====================================
    ENABLE_REGIME_BASED_EXITS: getEnvVarBool('ENABLE_REGIME_BASED_EXITS', true),
    REGIME_TAKE_PROFIT_TRENDING: getEnvVarNumber('REGIME_TAKE_PROFIT_TRENDING', 0.15),
    REGIME_STOP_LOSS_TRENDING: getEnvVarNumber('REGIME_STOP_LOSS_TRENDING', -0.20),
    REGIME_TAKE_PROFIT_RANGING: getEnvVarNumber('REGIME_TAKE_PROFIT_RANGING', 0.08),
    REGIME_STOP_LOSS_RANGING: getEnvVarNumber('REGIME_STOP_LOSS_RANGING', -0.10),
    ENABLE_PARTIAL_EXITS: getEnvVarBool('ENABLE_PARTIAL_EXITS', true),
    PARTIAL_EXIT_THRESHOLD: getEnvVarNumber('PARTIAL_EXIT_THRESHOLD', 0.05),
    PARTIAL_EXIT_PERCENT: getEnvVarNumber('PARTIAL_EXIT_PERCENT', 0.50),

    // =====================================
    // NEW: Kelly Portfolio Heat Management
    // =====================================
    MAX_PORTFOLIO_EXPOSURE: getEnvVarNumber('MAX_PORTFOLIO_EXPOSURE', 0.50),
    MAX_KELLY_HEAT: getEnvVarNumber('MAX_KELLY_HEAT', 0.30),
    MIN_CASH_RESERVE: getEnvVarNumber('MIN_CASH_RESERVE', 0.10),
    CONCENTRATION_FACTOR: getEnvVarNumber('CONCENTRATION_FACTOR', 1.5),

    // =====================================
    // NEW: Strategy Orchestrator Settings
    // =====================================
    ENABLE_STRATEGY_ORCHESTRATOR: getEnvVarBool('ENABLE_STRATEGY_ORCHESTRATOR', true),
    TARGET_WIN_RATE: getEnvVarNumber('TARGET_WIN_RATE', 0.80),
    MIN_WIN_RATE_ADJUSTMENT: getEnvVarNumber('MIN_WIN_RATE_ADJUSTMENT', 0.50),
    MAX_DAILY_TRADES: getEnvVarNumber('MAX_DAILY_TRADES', 50),
    MAX_DAILY_LOSS_PERCENT: getEnvVarNumber('MAX_DAILY_LOSS_PERCENT', 0.05),
    COMPOUND_RESET_DAYS: getEnvVarNumber('COMPOUND_RESET_DAYS', 30),
    
    // Strategy weights (can be adjusted dynamically)
    STRATEGY_WEIGHT_CERTAINTY: getEnvVarNumber('STRATEGY_WEIGHT_CERTAINTY', 0.40),
    STRATEGY_WEIGHT_CONFIDENCE: getEnvVarNumber('STRATEGY_WEIGHT_CONFIDENCE', 0.30),
    STRATEGY_WEIGHT_CROSS_MARKET: getEnvVarNumber('STRATEGY_WEIGHT_CROSS_MARKET', 0.20),
    STRATEGY_WEIGHT_TIME_DECAY: getEnvVarNumber('STRATEGY_WEIGHT_TIME_DECAY', 0.07),
    STRATEGY_WEIGHT_DIVERGENCE: getEnvVarNumber('STRATEGY_WEIGHT_DIVERGENCE', 0.03),
    
    // Certainty Arbitrage Settings
    CERTAINTY_SIGMA_THRESHOLD_BASE: getEnvVarNumber('CERTAINTY_SIGMA_THRESHOLD_BASE', 3.0),
    CERTAINTY_DAYS_TO_EVENT_MAX: getEnvVarNumber('CERTAINTY_DAYS_TO_EVENT_MAX', 3),
    CERTAINTY_MIN_EDGE: getEnvVarNumber('CERTAINTY_MIN_EDGE', 0.05),
    CERTAINTY_ONLY_MODE: getEnvVarBool('CERTAINTY_ONLY_MODE', false), // Only trade guaranteed outcomes
    
    // Cross-Market Lag Settings
    CROSS_MARKET_MIN_CORRELATION: getEnvVarNumber('CROSS_MARKET_MIN_CORRELATION', 0.60),
    CROSS_MARKET_MAX_LAG_SECONDS: getEnvVarNumber('CROSS_MARKET_MAX_LAG_SECONDS', 300),
    CROSS_MARKET_REENTRY_COOLDOWN_MINUTES: getEnvVarNumber('CROSS_MARKET_REENTRY_COOLDOWN_MINUTES', 10),
    
    // =====================================
    // NEW: Early Trigger / Anticipation System
    // =====================================
    ENABLE_EARLY_TRIGGER: getEnvVarBool('ENABLE_EARLY_TRIGGER', true),
    EARLY_TRIGGER_MINUTES_BEFORE: getEnvVarNumber('EARLY_TRIGGER_MINUTES_BEFORE', 2), // Start aggressive polling 2 min before expected
    EARLY_TRIGGER_AGGRESSIVE_POLL_MS: getEnvVarNumber('EARLY_TRIGGER_AGGRESSIVE_POLL_MS', 25), // 25ms polling in early trigger mode

    // =====================================
    // NEW: Transaction Costs & Safety Margins
    // =====================================
    POLYMARKET_FEE_RATE: 0,                                                          // Polymarket has NO transaction fees
    SAFETY_MARGIN_HIGH_CONFIDENCE: getEnvVarNumber('SAFETY_MARGIN_HIGH_CONFIDENCE', 0.01),     // 1% for 3σ+ trades
    SAFETY_MARGIN_MEDIUM_CONFIDENCE: getEnvVarNumber('SAFETY_MARGIN_MEDIUM_CONFIDENCE', 0.015), // 1.5% for 2σ+ trades
    SAFETY_MARGIN_LOW_CONFIDENCE: getEnvVarNumber('SAFETY_MARGIN_LOW_CONFIDENCE', 0.02),       // 2% for lower confidence trades
    BID_ASK_SPREAD_ESTIMATE: getEnvVarNumber('BID_ASK_SPREAD_ESTIMATE', 0.01),                 // 1% typical spread cost
    MIN_ADJUSTED_EDGE_THRESHOLD: getEnvVarNumber('MIN_ADJUSTED_EDGE_THRESHOLD', 0.02),         // 2% minimum adjusted edge

    // =====================================
    // NEW: Drawdown Kill Switch Settings
    // =====================================
    DRAWDOWN_DAILY_LOSS_LIMIT: getEnvVarNumber('DRAWDOWN_DAILY_LOSS_LIMIT', 0.05),             // 5% daily loss limit
    DRAWDOWN_MAX_DRAWDOWN_LIMIT: getEnvVarNumber('DRAWDOWN_MAX_DRAWDOWN_LIMIT', 0.15),         // 15% max drawdown from peak
    DRAWDOWN_CONSECUTIVE_LOSSES: getEnvVarNumber('DRAWDOWN_CONSECUTIVE_LOSSES', 5),            // Halt after 5 consecutive losses
    DRAWDOWN_COOLDOWN_HOURS: getEnvVarNumber('DRAWDOWN_COOLDOWN_HOURS', 24),                   // 24 hour cooldown after trigger
    DRAWDOWN_MIN_TRADES_BEFORE_KILL: getEnvVarNumber('DRAWDOWN_MIN_TRADES_BEFORE_KILL', 3),   // Min trades before kill switch activates

    // =====================================
    // NEW: Model Bias Correction Settings
    // =====================================
    MODEL_BIAS_CORRECTION_ENABLED: getEnvVarBool('MODEL_BIAS_CORRECTION_ENABLED', true),       // Enable bias correction
    MODEL_HORIZON_WEIGHTING_ENABLED: getEnvVarBool('MODEL_HORIZON_WEIGHTING_ENABLED', true),   // Enable horizon-aware weighting
    MODEL_ENSEMBLE_SPREAD_MULTIPLIER: getEnvVarNumber('MODEL_ENSEMBLE_SPREAD_MULTIPLIER', 0.5), // How much spread affects variance

    // =====================================
    // NEW: Late-Trade Detection Settings
    // =====================================
    LATE_TRADE_PRICE_VELOCITY_THRESHOLD: getEnvVarNumber('LATE_TRADE_PRICE_VELOCITY_THRESHOLD', 0.02),  // 2% price move in 5 min = late
    LATE_TRADE_EDGE_DECAY_FACTOR: getEnvVarNumber('LATE_TRADE_EDGE_DECAY_FACTOR', 0.5),                // Reduce edge when price moving against us
    LATE_TRADE_MIN_TIME_SINCE_FORECAST: getEnvVarNumber('LATE_TRADE_MIN_TIME_SINCE_FORECAST', 30000),   // 30 seconds max freshness

    // =====================================
    // NEW: Liquidity Filtering Settings
    // =====================================
    MIN_ORDER_BOOK_DEPTH_USD: getEnvVarNumber('MIN_ORDER_BOOK_DEPTH_USD', 1000),      // Minimum $1000 liquidity
    MAX_BID_ASK_SPREAD: getEnvVarNumber('MAX_BID_ASK_SPREAD', 0.03),                  // 3% max spread
    MIN_AVAILABLE_LIQUIDITY_SHARES: getEnvVarNumber('MIN_AVAILABLE_LIQUIDITY_SHARES', 500), // Minimum shares available

    // =====================================
    // NEW: Latency Tracking Settings
    // =====================================
    LATENCY_TRACKING_ENABLED: getEnvVarBool('LATENCY_TRACKING_ENABLED', true),        // Enable latency tracking
    LATENCY_LOG_ALL_TRACES: getEnvVarBool('LATENCY_LOG_ALL_TRACES', false),           // Only log slow traces if false
    LATENCY_SLOW_TRACE_THRESHOLD_MS: getEnvVarNumber('LATENCY_SLOW_TRACE_THRESHOLD_MS', 5000), // Log traces > 5 seconds
    LATENCY_STATS_WINDOW_SIZE: getEnvVarNumber('LATENCY_STATS_WINDOW_SIZE', 100),     // Keep last 100 traces for stats
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

// ============================================================
// STRATEGY ORCHESTRATOR CONFIG
// ============================================================
export const STRATEGY_CONFIG = {
    // Performance tracking
    TARGET_WIN_RATE: 0.80,
    MIN_SAMPLE_SIZE: 30,
    PERFORMANCE_DECAY_HALF_LIFE_MS: 60000,
    MIN_TRADES_FOR_WEIGHT_ADJUSTMENT: 50,
    WEIGHT_ADJUSTMENT_STEP: 0.05,
    
    // Signal filtering
    MIN_SIGNAL_CONFIDENCE: 0.6,
    MAX_SIGNALS_PER_CYCLE: 5,
};

// ============================================================
// ENTRY OPTIMIZER CONFIG  
// ============================================================
export const ENTRY_CONFIG = {
    // Kelly criterion
    KELLY_FRACTION: 0.25,
    MAX_KELLY_FRACTION: 0.50,
    MIN_KELLY_FRACTION: 0.10,
    
    // Volatility thresholds
    LOW_VOLATILITY_THRESHOLD: 0.02,
    HIGH_VOLATILITY_THRESHOLD: 0.05,
    VOLATILITY_MULTIPLIER: 10,
    
    // Edge thresholds
    MIN_EDGE_FOR_ENTRY: 0.05,
    HIGH_CONFIDENCE_EDGE_BOOST: 1.2,
};

// ============================================================
// EXIT OPTIMIZER CONFIG
// ============================================================
export const EXIT_CONFIG = {
    // Take profit thresholds - MATCH .env values (8% / -10%)
    TAKE_PROFIT_THRESHOLD: 0.08,
    PARTIAL_TAKE_PROFIT_THRESHOLD: 0.04,
    
    // Stop loss thresholds - MATCH .env values
    STOP_LOSS_THRESHOLD: -0.10,
    TRAILING_STOP_TRIGGER: 0.05,  // Activate at 5% profit
    TRAILING_STOP_DISTANCE: 0.025, // Trail 2.5% behind high water mark
    
    // Regime-based adjustments
    REGIME_TAKE_PROFIT_TRENDING: 0.20,  // 20% TP in trending markets
    REGIME_STOP_LOSS_TRENDING: -0.10,   // -10% SL in trending markets
    REGIME_TAKE_PROFIT_RANGING: 0.08,   // 8% TP in ranging markets
    REGIME_STOP_LOSS_RANGING: -0.04,    // -4% SL in ranging markets
    TRENDING_STOP_MULTIPLIER: 1.03,
    TRENDING_TAKE_MULTIPLIER: 1.2,
    RANGING_STOP_MULTIPLIER: 0.97,
    
    // Edge decay exit threshold
    EDGE_DECAY_EXIT_THRESHOLD: 0.02,  // Exit if edge decays below 2%
    EDGE_DECAY_HALF_LIFE_MS: 60000,   // 1 minute half-life for edge decay
    
    // Forecast-based exit
    FORECAST_REVERSAL_THRESHOLD: 0.05,  // Exit if forecast moves 5% against position
};

// ============================================================
// ORDER EXECUTION CONFIG
// ============================================================
export const ORDER_CONFIG = {
    // Rate limiting
    ORDER_COOLDOWN_MS: 30000,
    MAX_CONCURRENT_ORDERS: 5,
    MAX_POSITION_SIZE: 0.15,  // 15% of bankroll
    MIN_ORDER_SIZE: 0.02,     // 2% of bankroll
    
    // Price improvement
    PRICE_IMPROVEMENT_INCREMENT: 0.05,
    MIN_PRICE_IMPROVEMENT: 0.01,
    
    // Kelly sizing
    KELLY_MULTIPLIER: 0.5,
    MAX_KELLY_SIZE: 10,
};

// ============================================================
// SPEED ARBITRAGE CONFIG
// ============================================================
export const SPEED_ARBITRAGE_CONFIG = {
    MAX_CHANGE_AGE_MS: 120000,
    MIN_CONFIDENCE: 0.5,
    MIN_EDGE: 0.03,
    UNCERTAINTY_BASE: 3,
    UNCERTAINTY_MULTIPLIER: 1.5,
    CONFIDENCE_DIVISOR: 0.8,
    // Threshold crossing settings - DISABLED by default to capture more signals
    REQUIRE_THRESHOLD_CROSSING: false,   // Don't require threshold crossing
    MIN_CROSSING_DISTANCE: 0.5,         // Minimum distance from threshold (°F)
};

// ============================================================
// CROSS MARKET CONFIG
// ============================================================
export const CROSS_MARKET_CONFIG = {
    MIN_CORRELATION: 0.60,
    MAX_LAG_MS: 300,
    MIN_EDGE_DIFFERENTIAL: 0.03,
};

// ============================================================
// DASHBOARD THRESHOLDS
// ============================================================
export const DASHBOARD_THRESHOLDS = {
    temperature: 0.60,
    precipitation: 0.75,
};
