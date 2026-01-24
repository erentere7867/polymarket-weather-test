# Polymarket Weather Arbitrage Bot

A bot that exploits mispriced weather prediction markets on Polymarket by obtaining weather forecasts faster than the market updates.

## Strategy

Weather prediction markets (e.g., "Will NYC high temperature exceed 40°F today?") have odds that may lag behind official weather forecasts. By fetching forecast data from authoritative sources (NOAA NWS, OpenWeatherMap, Open-Meteo) before the market updates, we can identify and capitalize on mispriced positions.

## Features

- **Weather Data Sources**:
  - NOAA National Weather Service (free, no API key, US only)
  - OpenWeatherMap (requires API key, international coverage)
  - Open-Meteo (free, no API key, global fallback)

- **Market Types Supported**:
  - Temperature high/low predictions
  - Snowfall accumulation
  - Precipitation probability

- **Risk Management**:
  - Full portfolio simulation mode with $1M starting capital
  - Configurable edge threshold
  - Kelly criterion position sizing
  - Take profit and stop loss controls
  - Maximum position size limits

- **Real-time Updates**:
  - WebSocket support for live price updates
  - Auto-reconnection on disconnect

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

Environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Polygon wallet private key | Required for live trading |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key | Optional (for international markets) |
| `SIMULATION_MODE` | Run without placing real trades | `true` |
| `MAX_POSITION_SIZE` | Maximum USDC per trade | `10` |
| `MIN_EDGE_THRESHOLD` | Minimum edge to trigger trade (0-1) | `0.10` (10%) |
| `POLL_INTERVAL_MS` | Time between scan cycles | `300000` (5 min) |

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
   Max Position Size:    $50,000
   Min Edge Threshold:   8%
   Take Profit:          25%
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
   Win Rate:            0.0%
```

## How It Works

1. **Market Discovery**: Scans Polymarket for weather-related markets
2. **Weather Fetch**: Gets latest forecasts from NOAA/OpenWeatherMap/Open-Meteo
3. **Opportunity Detection**: Compares forecast probability to market price
4. **Trade Execution**: Places orders when edge exceeds threshold
5. **Position Management**: Auto take-profit/stop-loss on positions

### Edge Calculation

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
├── weather/
│   ├── noaa-client.ts           # NOAA NWS API
│   ├── openweather-client.ts    # OpenWeatherMap API
│   ├── openmeteo-client.ts      # Open-Meteo API (free fallback)
│   ├── index.ts                 # Weather service aggregator
│   └── types.ts
├── simulation/
│   ├── portfolio.ts             # Portfolio tracking & PnL
│   ├── runner.ts                # Simulation orchestrator
│   └── index.ts
├── test/
│   ├── scan-weather-markets.ts
│   ├── fetch-weather.ts
│   └── analyze-opportunities.ts
├── config.ts
├── logger.ts
├── index.ts
└── run-simulation.ts            # Simulation entry point
```

## Risk Disclaimer

⚠️ **This bot involves financial risk.** 

- Weather forecasts are not perfect
- Markets may be correctly priced
- Slippage and fees can erode profits
- Always test thoroughly in simulation mode first
- Never trade with funds you can't afford to lose

## License

MIT

