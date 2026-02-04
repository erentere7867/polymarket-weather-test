# Polymarket Weather Arbitrage Bot

A high-performance bot that exploits mispriced weather prediction markets on Polymarket by obtaining weather forecasts faster than the market updates. Features advanced speed arbitrage, cross-market correlation trading, and market impact modeling.

## Strategy

Weather prediction markets (e.g., "Will NYC high temperature exceed 40°F today?") have odds that may lag behind official weather forecasts. By fetching forecast data from authoritative sources (NOAA NWS, OpenWeatherMap, Open-Meteo) before the market updates, we can identify and capitalize on mispriced positions.

### Key Improvements (v2.0)

The bot has been significantly enhanced with:
- **Speed Arbitrage Strategy**: Relaxed thresholds for faster trade detection
- **Cross-Market Arbitrage**: Exploit correlations between related weather markets
- **Market Impact Modeling**: Estimate and minimize slippage on large orders
- **Adaptive Detection Windows**: Align with actual NOAA model publication times
- **Advanced Entry/Exit Optimization**: Kelly criterion sizing, trailing stops, fair value exits

See [IMPROVEMENTS.md](docs/IMPROVEMENTS.md) for detailed documentation.

## Features

### Core Trading Features

- **Speed Arbitrage**: Lightning-fast opportunity detection with relaxed thresholds
- **Cross-Market Arbitrage**: Trade correlations between related cities (15+ known pairs)
- **Market Impact Modeling**: Square-root law estimation with position scaling
- **Advanced Risk Management**: Kelly criterion sizing, trailing stops, volatility adjustment

### Weather Data Sources

- **NOAA National Weather Service** (free, no API key, US only)
- **OpenWeatherMap** (requires API key, international coverage)
- **Open-Meteo** (free, no API key, global fallback)

### File-Based Weather Ingestion (NEW)

- Direct S3 file detection from NOAA buckets (sub-5-second latency)
- Dual-path architecture: file-based primary + API fallback
- Supports HRRR, RAP, and GFS models for 13 cities
- GRIB2 parsing with wgrib2 for high-resolution data
- See [File-Based Ingestion Documentation](docs/FILE_INGESTION.md)

### Market Types Supported

- Temperature high/low predictions
- Snowfall accumulation
- Precipitation probability
- Wind speed predictions

### Risk Management

- Full portfolio simulation mode with $1M starting capital
- Configurable edge threshold (default: 8%)
- Kelly criterion position sizing (fractional: 0.25x)
- Take profit (10%) and stop loss (-15%) controls
- Trailing stops for profit protection
- Maximum position size limits ($50)
- Market impact-aware order sizing

### Real-time Updates

- WebSocket support for live price updates
- Auto-reconnection on disconnect
- Event-driven forecast change detection
- Adaptive detection windows based on NOAA schedules

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. **Run portfolio simulation** (paper trading with $1M):
   ```bash
   npm run simulate
   # Or specify number of cycles:
   npm run simulate -- 20
   ```

4. **Run the live bot** (simulation mode by default):
   ```bash
   npm run dev
   ```

## Configuration

### Core Trading Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Polygon wallet private key | Required for live trading |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key | Optional (for international markets) |
| `SIMULATION_MODE` | Run without placing real trades | `true` |
| `MAX_POSITION_SIZE` | Maximum USDC per trade | `50` |
| `MIN_EDGE_THRESHOLD` | Minimum edge to trigger trade | `0.08` (8%) |
| `TAKE_PROFIT_THRESHOLD` | Profit target for exits | `0.10` (10%) |
| `STOP_LOSS_THRESHOLD` | Loss limit for exits | `-0.15` (-15%) |

### Speed Arbitrage Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_SPEED_ARBITRAGE` | Enable speed arbitrage strategy | `true` |
| `SPEED_ARB_MIN_SIGMA` | Minimum sigma for speed arbitrage | `0.0` |
| `SPEED_ARB_MAX_CHANGE_AGE_MS` | Max age of forecast change | `120000` (2 min) |
| `SPEED_ARB_MIN_CONFIDENCE` | Minimum confidence threshold | `0.75` |

### Cross-Market Arbitrage Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_CROSS_MARKET_ARBITRAGE` | Enable cross-market strategy | `true` |
| `CROSS_MARKET_MIN_EDGE` | Minimum edge for cross-market trades | `0.06` (6%) |
| `CROSS_MARKET_MIN_CORRELATION` | Minimum correlation coefficient | `0.70` |
| `CROSS_MARKET_MAX_LAG_MINUTES` | Maximum lag for correlated markets | `180` |

### Market Impact Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_MARKET_IMPACT_MODEL` | Enable market impact estimation | `true` |
| `MARKET_IMPACT_CONSTANT_LOW` | Impact constant for liquid markets | `0.3` |
| `MARKET_IMPACT_CONSTANT_MEDIUM` | Impact constant for average markets | `0.8` |
| `MARKET_IMPACT_CONSTANT_HIGH` | Impact constant for illiquid markets | `1.5` |
| `MAX_MARKET_IMPACT_THRESHOLD` | Maximum acceptable impact | `0.02` (2%) |
| `ENABLE_POSITION_SCALING` | Scale large orders into chunks | `true` |
| `POSITION_SCALE_THRESHOLD` | Size threshold for scaling | `100` |

### File-Based Ingestion Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_FILE_BASED_INGESTION` | Enable direct S3 file detection | `true` |
| `S3_POLL_INTERVAL_MS` | S3 HeadObject poll interval | `150` |
| `DETECTION_WINDOW_BUFFER_MINUTES` | Buffer before expected publication | `5` |
| `API_FALLBACK_MAX_DURATION_MINUTES` | Max API polling duration | `5` |
| `FORECAST_CHANGE_THRESHOLD_CELSIUS` | Temperature change threshold | `0.5` |
| `FORECAST_CHANGE_THRESHOLD_WIND_KPH` | Wind speed change threshold | `2` |
| `FORECAST_CHANGE_THRESHOLD_PRECIP_MM` | Precipitation change threshold | `0.1` |

### Advanced Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `KELLY_FRACTION` | Kelly criterion multiplier | `0.25` |
| `TRAILING_STOP_ENABLED` | Enable trailing stops | `true` |
| `TRAILING_STOP_ACTIVATION` | Profit level to activate | `0.05` (5%) |
| `TRAILING_STOP_OFFSET` | Stop offset from peak | `0.02` (2%) |
| `ENABLE_ADAPTIVE_DETECTION_WINDOWS` | Learn from historical data | `true` |
| `ADAPTIVE_WINDOW_MIN_OBSERVATIONS` | Min observations to adjust | `5` |

## Scripts

```bash
# Run full portfolio simulation ($1M capital)
npm run simulate

# Run the bot
npm run dev

# Scan for weather markets only
npm run scan

# Analyze opportunities
npm run analyze

# Test weather data fetching
npm run test:weather

# Test file-based ingestion system
npm run test:file-ingestion

# Run latency benchmark
npm run benchmark:latency

# Run parameter optimization
npm run simulate -- --optimize

# Build for production
npm run build
npm start
```

## Portfolio Simulation

The simulation mode runs with a virtual $1,000,000 portfolio:

```
══════════════════════════════════════════════════════════════════════
       POLYMARKET WEATHER ARBITRAGE BOT - SIMULATION MODE
══════════════════════════════════════════════════════════════════════

   Starting Capital:     $1,000,000
   Max Position Size:    $50
   Min Edge Threshold:   8%
   Take Profit:          10%
   Stop Loss:            15%

══════════════════════════════════════════════════════════════════════
                        PORTFOLIO SUMMARY
══════════════════════════════════════════════════════════════════════

💰 CASH & VALUE
   Starting Capital:    $1,000,000
   Current Cash:        $685,988
   Portfolio Value:     $974,037
   Current Exposure:    $294,364

📊 PROFIT & LOSS
   Unrealized P&L:      -$6,315
   Realized P&L:        -$19,647
   Total P&L:           -$25,962 (-2.60%)
   Max Drawdown:        -2.81%

📈 TRADING STATS
   Open Positions:      6
   Closed Positions:    2
   Win Rate:            45.2%

📊 Component Performance Metrics:
  Speed Arbitrage: 45 signals, 12 trades, 15.3ms avg execution
  Cross-Market: 8 opportunities detected
  Entry Optimizer: 20 optimizations, 3 scaling events
  Exit Optimizer: 5 exits (2 trailing, 1 TP, 2 SL)
  Market Impact Model: 20 estimates, 87.5% accuracy
```

## How It Works

### 1. Market Discovery
Scans Polymarket for weather-related markets using the Gamma API.

### 2. Weather Data Acquisition
- **Primary**: File-based S3 detection for sub-5-second latency
- **Fallback**: API polling during detection windows
- **Sources**: NOAA, OpenWeatherMap, Open-Meteo

### 3. Opportunity Detection

**Speed Arbitrage:**
- Detects forecast changes within 2 minutes of publication
- Uses relaxed sigma threshold (0.0 vs 3.0 previously)
- Trades on any statistically significant change

**Cross-Market Arbitrage:**
- Monitors correlations between related cities
- Trades lagging markets when leading markets move
- 15+ known city correlations (e.g., NYC ↔ DC)

### 4. Entry Optimization

The entry optimizer considers:
- **Kelly Criterion**: Optimal position sizing based on edge and win rate
- **Market Impact**: Estimates slippage using square-root law
- **Volatility**: Adjusts size based on market volatility
- **Liquidity**: Considers order book depth and spread

```
Position Size = min(
    Kelly Size * kellyFraction,
    maxPositionSize,
    liquidityAdjustedSize
) * volatilityMultiplier
```

### 5. Exit Optimization

**Exit Triggers:**
- **Take Profit**: 10% profit target
- **Stop Loss**: 15% loss limit
- **Trailing Stop**: Locks in profits after 5% gain
- **Fair Value Exit**: Exits when market converges to forecast

### 6. Edge Calculation

```
Edge = Forecast Probability - Market Price
```

If `Edge > MIN_EDGE_THRESHOLD`, the market is underpricing the YES outcome (buy YES).
If `Edge < -MIN_EDGE_THRESHOLD`, the market is overpricing the YES outcome (buy NO).

## Project Structure

```
src/
├── bot/
│   ├── manager.ts               # Main bot orchestrator
│   ├── opportunity-detector.ts  # Compares weather to market
│   └── order-executor.ts        # Executes trades
├── polymarket/
│   ├── gamma-client.ts          # Market discovery API
│   ├── clob-client.ts           # Trading API
│   ├── websocket-client.ts      # Real-time price updates
│   ├── weather-scanner.ts       # Finds weather markets
│   └── types.ts
├── strategy/
│   ├── speed-arbitrage.ts       # Speed arbitrage strategy
│   ├── cross-market-arbitrage.ts # Cross-market correlation trading
│   ├── entry-optimizer.ts       # Entry optimization with Kelly criterion
│   ├── exit-optimizer.ts        # Exit optimization with trailing stops
│   └── market-impact.ts         # Market impact modeling
├── weather/
│   ├── noaa-client.ts           # NOAA NWS API
│   ├── openweather-client.ts    # OpenWeatherMap API
│   ├── openmeteo-client.ts      # Open-Meteo API (free fallback)
│   ├── file-based-ingestion.ts  # Main file ingestion controller
│   ├── schedule-manager.ts      # Model schedule calculation
│   ├── s3-file-detector.ts      # S3 HeadObject polling
│   ├── grib2-parser.ts          # GRIB2 file parsing
│   ├── api-fallback-poller.ts   # API fallback during detection
│   ├── hybrid-weather-controller.ts # Adaptive detection windows
│   ├── index.ts                 # Weather service aggregator
│   └── types.ts
├── realtime/
│   ├── event-bus.ts             # Event-driven communication
│   ├── data-store.ts            # Forecast state management
│   ├── hybrid-weather-controller.ts  # Mode switching logic
│   └── types.ts
├── simulation/
│   ├── portfolio.ts             # Portfolio tracking & PnL
│   ├── runner.ts                # Simulation orchestrator
│   └── index.ts
├── test/
│   ├── scan-weather-markets.ts
│   ├── fetch-weather.ts
│   ├── analyze-opportunities.ts
│   ├── file-based-ingestion.test.ts  # File ingestion tests
│   └── latency-benchmark.ts     # Performance benchmarking
├── config.ts
├── logger.ts
├── index.ts
└── run-simulation.ts            # Simulation entry point
```

## File-Based Weather Ingestion

The bot includes a high-performance file-based weather ingestion system that detects NOAA model file appearance directly from S3 buckets, achieving **sub-5-second latency** from file publication to signal emit.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    File-Based Ingestion System                       │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │   Schedule   │───▶│  S3 File     │───▶│   GRIB2      │          │
│  │   Manager    │    │  Detector    │    │   Parser     │          │
│  └──────────────┘    └──────────────┘    └──────────────┘          │
│         │                   │                   │                   │
│         ▼                   ▼                   ▼                   │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              EventBus (FILE_CONFIRMED)                    │      │
│  └──────────────────────────────────────────────────────────┘      │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │         ForecastChangeDetector (thresholds)               │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Dual-Path Architecture**: File-based detection (primary) + API fallback (secondary)
- **Sub-5-Second Latency**: From file appearance to FORECAST_CHANGE event
- **Direct S3 Access**: Uses HeadObject polling (150ms intervals) on public NOAA buckets
- **Three Model Types**:
  - **HRRR**: High-Resolution Rapid Refresh (CONUS, hourly cycles)
  - **RAP**: Rapid Refresh (CONUS + S. Canada, hourly cycles)
  - **GFS**: Global Forecast System (Global, 6-hour cycles)

### Supported Cities (13 Total)

| City | Primary Model | Coordinates |
|------|--------------|-------------|
| New York City | HRRR | 40.71°N, 74.01°W |
| Washington DC | HRRR | 38.91°N, 77.04°W |
| Chicago | HRRR | 41.88°N, 87.63°W |
| Los Angeles | HRRR | 34.05°N, 118.24°W |
| Miami | HRRR | 25.76°N, 80.19°W |
| Dallas | HRRR | 32.78°N, 96.80°W |
| Seattle | HRRR | 47.61°N, 122.33°W |
| Atlanta | HRRR | 33.75°N, 84.39°W |
| Toronto | GFS | 43.65°N, 79.38°W |
| London | GFS | 51.51°N, 0.13°W |
| Seoul | GFS | 37.57°N, 126.98°E |
| Ankara | GFS | 39.93°N, 32.86°E |
| Buenos Aires | GFS | 34.60°S, 58.38°W |

### Quick Start

1. **Enable file-based ingestion** (enabled by default):
   ```bash
   ENABLE_FILE_BASED_INGESTION=true
   ```

2. **Configure polling interval** (optional):
   ```bash
   S3_POLL_INTERVAL_MS=150  # 150ms = 6-7 checks per second
   ```

3. **Run the system**:
   ```bash
   npm run dev
   ```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- cross-market-arbitrage.test.ts
npm test -- entry-optimizer.test.ts
npm test -- market-impact.test.ts
npm test -- file-based-ingestion.test.ts
npm test -- improvements-validation.test.ts
```

### Integration Tests

```bash
# Test weather data fetching
npm run test:weather

# Test file-based ingestion
npm run test:file-ingestion

# Run latency benchmark
npm run benchmark:latency
```

### Simulation Testing

```bash
# Run with default settings
npm run simulate

# Run with custom cycles
npm run simulate -- 50

# Run parameter optimization
npm run simulate -- --optimize

# Run with specific parameters
npm run simulate -- --takeProfit=0.15 --stopLoss=-0.10
```

## Performance Tuning

See [PERFORMANCE_TUNING.md](docs/PERFORMANCE_TUNING.md) for detailed tuning guidance.

### Quick Profiles

**Conservative Profile**
```bash
MIN_EDGE_THRESHOLD=0.15
STOP_LOSS_THRESHOLD=-0.10
MAX_POSITION_SIZE=20
KELLY_FRACTION=0.15
ENABLE_CROSS_MARKET_ARBITRAGE=false
```

**Balanced Profile (Recommended)**
```bash
MIN_EDGE_THRESHOLD=0.08
STOP_LOSS_THRESHOLD=-0.15
MAX_POSITION_SIZE=50
KELLY_FRACTION=0.25
ENABLE_CROSS_MARKET_ARBITRAGE=true
```

**Aggressive Profile**
```bash
MIN_EDGE_THRESHOLD=0.05
STOP_LOSS_THRESHOLD=-0.20
MAX_POSITION_SIZE=100
KELLY_FRACTION=0.50
ENABLE_CROSS_MARKET_ARBITRAGE=true
```

## Documentation

- [Improvements Documentation](docs/IMPROVEMENTS.md) - Detailed problem analysis and changes
- [Performance Tuning Guide](docs/PERFORMANCE_TUNING.md) - Parameter optimization guide
- [File Ingestion Architecture](docs/FILE_INGESTION.md) - Detailed component documentation
- [Operations Runbook](docs/OPERATIONS.md) - Deployment and troubleshooting guide
- [Latency Budget](docs/LATENCY_BUDGET.md) - Performance requirements and benchmarks
- [Weather Module](src/weather/README.md) - Module structure and API reference

## Risk Disclaimer

⚠️ **This bot involves financial risk.**

- Weather forecasts are not perfect
- Markets may be correctly priced
- Slippage and fees can erode profits
- Always test thoroughly in simulation mode first
- Never trade with funds you can't afford to lose

## License

MIT
