# Performance Tuning Guide

## Overview

This guide provides detailed instructions for tuning the Polymarket Weather Arbitrage Bot to optimize performance based on your risk tolerance, capital, and market conditions.

---

## Table of Contents

1. [Parameter Optimization](#parameter-optimization)
2. [Risk Management](#risk-management)
3. [Market Impact Tuning](#market-impact-tuning)
4. [Detection Window Tuning](#detection-window-tuning)
5. [Simulation-Based Optimization](#simulation-based-optimization)

---

## Parameter Optimization

### Using the Simulation Runner

The simulation runner includes a built-in parameter optimization framework:

```typescript
// In src/simulation/runner.ts
interface OptimizationParameter {
    name: string;
    currentValue: number;
    minValue: number;
    maxValue: number;
    stepSize: number;
    testResults: Array<{
        value: number;
        pnl: number;
        sharpeRatio: number;
        maxDrawdown: number;
    }>;
}
```

### Running Parameter Optimization

```bash
# Run the simulation with parameter optimization
npm run simulate -- --optimize

# Or programmatically
import { SimulationRunner } from './src/simulation/runner.js';

const runner = new SimulationRunner(1000000, 100);  // $1M capital, 100 cycles
await runner.start();
await runner.runParameterOptimization();
```

### Key Parameters to Optimize

| Parameter | Default | Range | Impact |
|-----------|---------|-------|--------|
| `takeProfit` | 10% | 5-20% | Higher = fewer exits, larger wins |
| `stopLoss` | -15% | -25 to -5% | Tighter = less risk, more stops |
| `minEdgeThreshold` | 8% | 5-20% | Lower = more trades, lower quality |
| `maxPositionSize` | $50 | $5-100 | Higher = more exposure, more impact |
| `kellyFraction` | 0.25 | 0.1-0.5 | Higher = more aggressive sizing |

### Optimization Strategy

1. **Grid Search**: Test all combinations in range
2. **Walk-Forward**: Optimize on historical data, test on recent data
3. **Adaptive**: Adjust parameters based on recent performance

```typescript
// Example: Grid search configuration
const optimizationParams = [
    {
        name: 'takeProfit',
        currentValue: 0.10,
        minValue: 0.05,
        maxValue: 0.20,
        stepSize: 0.01,
        testResults: [],
    },
    {
        name: 'stopLoss',
        currentValue: -0.15,
        minValue: -0.25,
        maxValue: -0.05,
        stepSize: 0.01,
        testResults: [],
    },
];
```

---

## Risk Management

### Take Profit Settings

**Conservative (Lower Risk)**
```bash
TAKE_PROFIT_THRESHOLD=0.05  # 5% - Quick scalping
```
- Pros: Lock in profits quickly, lower volatility
- Cons: Miss larger moves, higher transaction costs

**Balanced (Recommended)**
```bash
TAKE_PROFIT_THRESHOLD=0.10  # 10% - Let winners run
```
- Pros: Capture medium-sized moves, good risk/reward
- Cons: Some profits given back

**Aggressive (Higher Risk)**
```bash
TAKE_PROFIT_THRESHOLD=0.20  # 20% - Home runs only
```
- Pros: Capture large moves, lower transaction costs
- Cons: Many trades turn into losses

### Stop Loss Settings

**Tight Stops**
```bash
STOP_LOSS_THRESHOLD=-0.10  # 10% max loss
```
- Use when: High volatility, uncertain forecasts
- Risk: Whipsaws, stopped out on noise

**Normal Stops**
```bash
STOP_LOSS_THRESHOLD=-0.15  # 15% max loss
```
- Use when: Normal market conditions
- Risk: Balanced

**Loose Stops**
```bash
STOP_LOSS_THRESHOLD=-0.25  # 25% max loss
```
- Use when: High confidence in forecasts
- Risk: Larger drawdowns

### Trailing Stops

```bash
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ACTIVATION=0.05  # Activate at 5% profit
TRAILING_STOP_OFFSET=0.02      # Stop at breakeven + 2%
```

**How it works:**
1. Position reaches 5% profit → Trailing stop activates
2. Price continues to 10% → Stop moves to 8% (10% - 2%)
3. Price drops to 8% → Position exits with 8% profit

### Position Sizing

**Kelly Criterion Formula:**
```
f* = (p*b - q) / b

Where:
- f* = optimal fraction of capital
- p = probability of win
- b = win/loss ratio
- q = probability of loss (1 - p)
```

**Kelly Fraction Settings:**

| Fraction | Risk Level | Description |
|----------|------------|-------------|
| 0.10 | Very Conservative | 1/10 Kelly, minimal risk |
| 0.25 | Conservative | Quarter Kelly, recommended |
| 0.50 | Moderate | Half Kelly, higher returns |
| 1.00 | Aggressive | Full Kelly, high volatility |

```bash
# Recommended for most users
KELLY_FRACTION=0.25

# For larger capital bases (> $100K)
KELLY_FRACTION=0.15

# For smaller capital (< $10K) willing to take risk
KELLY_FRACTION=0.50
```

### Maximum Position Size

```bash
# Conservative - limit exposure
MAX_POSITION_SIZE=20

# Balanced - moderate exposure
MAX_POSITION_SIZE=50

# Aggressive - full Kelly sizing
MAX_POSITION_SIZE=100
```

**Considerations:**
- Market liquidity: Lower for illiquid markets
- Capital base: Scale with portfolio size
- Correlation: Reduce if holding correlated positions

---

## Market Impact Tuning

### Understanding Market Impact

The bot uses the square-root law:
```
impact = k * sqrt(order_size / daily_volume)
```

**Impact Constants:**

| Market Type | k Value | Example Markets |
|-------------|---------|-----------------|
| Liquid | 0.3 | Major cities, high volume |
| Average | 0.8 | Medium cities, medium volume |
| Illiquid | 1.5 | Small cities, low volume |

### Tuning Impact Constants

```bash
# For liquid markets (daily volume > $100K)
MARKET_IMPACT_CONSTANT_LOW=0.3

# For average markets ($10K-100K daily volume)
MARKET_IMPACT_CONSTANT_MEDIUM=0.8

# For illiquid markets (< $10K daily volume)
MARKET_IMPACT_CONSTANT_HIGH=1.5
```

### Maximum Acceptable Impact

```bash
# Conservative - minimize slippage
MAX_MARKET_IMPACT_THRESHOLD=0.01  # 1%

# Balanced - allow moderate impact
MAX_MARKET_IMPACT_THRESHOLD=0.02  # 2%

# Aggressive - accept higher impact for entry
MAX_MARKET_IMPACT_THRESHOLD=0.05  # 5%
```

### Position Scaling

For large orders, the bot can scale into positions:

```bash
# Enable position scaling
ENABLE_POSITION_SCALING=true

# Scale in for positions larger than this
POSITION_SCALE_THRESHOLD=100  # $100
```

**Scaling Strategy:**
- Order size $150 → 3 tranches of $50
- Order size $300 → 3 tranches of $100
- Delay between tranches: 2 seconds

### Liquidity-Based Sizing

The entry optimizer considers:
1. **Order Book Depth**: Don't exceed 10% of depth
2. **Spread**: Wider spreads = smaller size
3. **Volume**: Lower volume = smaller size

**Example:**
```
Desired size: $100
Order book depth: $500
Spread: 3%
→ Adjusted size: $100 * 0.5 (depth) * 0.7 (spread) = $35
```

---

## Detection Window Tuning

### Understanding NOAA Model Schedules

| Model | Cycle | Publication Time | Detection Window |
|-------|-------|------------------|------------------|
| HRRR | Hourly | +25-35 min | 25-45 min |
| RAP | Hourly | +25-32 min | 25-40 min |
| GFS | 6-hourly | +5-15 min | 5-20 min |
| ECMWF | 12-hourly | +40-60 min | 40-70 min |

### Adjusting Detection Windows

```bash
# Buffer before expected publication
DETECTION_WINDOW_BUFFER_MINUTES=5

# How long to poll after expected time
API_FALLBACK_MAX_DURATION_MINUTES=5
```

### Adaptive Windows

The bot can learn from historical publication times:

```bash
# Enable adaptive windows
ENABLE_ADAPTIVE_DETECTION_WINDOWS=true

# Minimum observations before adjusting
ADAPTIVE_WINDOW_MIN_OBSERVATIONS=5

# Standard deviation factor for window
ADAPTIVE_WINDOW_STD_DEV_FACTOR=1.0
```

**How it works:**
1. Track actual publication times
2. Calculate average and standard deviation
3. Adjust window: `start = avg - std_dev - 2min`
4. Adjust window: `end = avg + std_dev + 5min`

### Early Detection Mode

```bash
# Confidence threshold to trigger early detection
EARLY_DETECTION_CONFIDENCE_THRESHOLD=0.7

# Maximum duration in early detection
EARLY_DETECTION_MAX_DURATION_MS=300000  # 5 minutes
```

**When triggered:**
- High confidence data arrives before detection window
- Bot enters fast polling mode (1 second intervals)
- Exits after 5 minutes or when window starts

### Tuning for Your Location

**US East Coast (HRRR/RAP primary):**
```bash
S3_POLL_INTERVAL_MS=150
DETECTION_WINDOW_BUFFER_MINUTES=5
```

**International (GFS primary):**
```bash
S3_POLL_INTERVAL_MS=200
DETECTION_WINDOW_BUFFER_MINUTES=3
```

**High-frequency trading:**
```bash
S3_POLL_INTERVAL_MS=100  # 10 checks per second
DETECTION_WINDOW_BUFFER_MINUTES=7  # Start earlier
```

---

## Simulation-Based Optimization

### Running Backtests

```bash
# Run simulation with default settings
npm run simulate

# Run with custom cycles
npm run simulate -- 50

# Run with specific parameters
npm run simulate -- --takeProfit=0.15 --stopLoss=-0.10
```

### Analyzing Results

The simulation outputs:

```
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

### Component Performance Metrics

```
📊 Component Performance Metrics:
  Speed Arbitrage: 45 signals, 12 trades, 15.3ms avg execution
  Cross-Market: 8 opportunities detected
  Entry Optimizer: 20 optimizations, 3 scaling events
  Exit Optimizer: 5 exits (2 trailing, 1 TP, 2 SL)
  Market Impact Model: 20 estimates, 87.5% accuracy
```

### Optimization Workflow

1. **Baseline Run**
   ```bash
   npm run simulate -- 100 > baseline.log
   ```

2. **Parameter Sweep**
   ```bash
   for tp in 0.05 0.10 0.15 0.20; do
     npm run simulate -- --takeProfit=$tp > tp_$tp.log
   done
   ```

3. **Analyze Results**
   ```bash
   grep "Total P&L" *.log | sort -k3 -n
   ```

4. **Select Optimal**
   - Choose parameters with best risk-adjusted returns
   - Consider Sharpe ratio, not just total PnL
   - Ensure max drawdown is acceptable

### Walk-Forward Optimization

```bash
# Optimize on first 70% of data
npm run simulate -- --optimize --trainRatio=0.7

# Test on remaining 30%
npm run simulate -- --test --params=optimized.json
```

---

## Advanced Tuning

### Volatility Regime Detection

The entry optimizer adjusts sizing based on volatility:

```typescript
// Volatility multipliers
LOW_VOLATILITY: 1.2      // Increase size 20%
MEDIUM_VOLATILITY: 1.0   // Normal sizing
HIGH_VOLATILITY: 0.7     // Reduce size 30%
EXTREME_VOLATILITY: 0.4  // Reduce size 60%
```

**Tuning thresholds:**
```typescript
private readonly VOLATILITY_LOW = 0.01;      // 1% price movement
private readonly VOLATILITY_HIGH = 0.05;     // 5% price movement
private readonly VOLATILITY_EXTREME = 0.10;  // 10% price movement
```

### Cross-Market Correlation Tuning

Add custom correlations for your markets:

```typescript
// In src/strategy/cross-market-arbitrage.ts
const KNOWN_CITY_CORRELATIONS: CityCorrelation[] = [
    // Add your custom correlations
    { 
        cityA: 'your_city_1', 
        cityB: 'your_city_2', 
        correlationCoefficient: 0.80, 
        distanceKm: 100, 
        typicalLagMinutes: 60, 
        confidence: 0.75, 
        lastUpdated: new Date() 
    },
];
```

### API Rate Limit Management

```bash
# Open-Meteo hard quota (free tier)
OPENMETEO_HARD_QUOTA=9500

# Warning at 90% of quota
QUOTA_WARNING_THRESHOLD=0.90

# Switch to fallback at 95%
QUOTA_FALLBACK_THRESHOLD=0.95
```

---

## Monitoring and Adjustment

### Daily Checklist

- [ ] Check trade frequency (target: 5-10/day)
- [ ] Verify win rate (target: 45-55%)
- [ ] Review average edge (target: 6-10%)
- [ ] Check market impact accuracy (target: >80%)
- [ ] Verify detection latency (target: <10s)

### Weekly Review

1. **Analyze PnL by Component**
   - Speed arbitrage vs cross-market
   - Entry optimizer performance
   - Exit optimizer effectiveness

2. **Review Parameter Performance**
   - Are take profit levels appropriate?
   - Is stop loss too tight/loose?
   - Is position sizing optimal?

3. **Adjust if Necessary**
   - Small adjustments (±2-5%)
   - One parameter at a time
   - Document changes and results

### Monthly Deep Dive

1. **Correlation Analysis**
   - Update city correlations based on actual data
   - Add/remove correlations as needed

2. **Model Schedule Validation**
   - Check actual vs expected publication times
   - Adjust detection windows if needed

3. **Strategy Refinement**
   - Add new market types if supported
   - Remove underperforming strategies

---

## Troubleshooting

### Low Trade Frequency

**Symptoms:** < 3 trades/day

**Solutions:**
1. Lower `MIN_EDGE_THRESHOLD` (try 5%)
2. Reduce `MIN_SIGMA_FOR_ARBITRAGE` (try 0.5)
3. Enable cross-market arbitrage
4. Check detection windows are aligned

### High Slippage

**Symptoms:** Actual edge < 50% of expected

**Solutions:**
1. Reduce `MAX_POSITION_SIZE`
2. Enable position scaling
3. Increase `MARKET_IMPACT_CONSTANT_*` values
4. Lower `MAX_MARKET_IMPACT_THRESHOLD`

### Low Win Rate

**Symptoms:** < 40% win rate

**Solutions:**
1. Increase `MIN_EDGE_THRESHOLD`
2. Increase `MIN_SIGMA_FOR_ARBITRAGE`
3. Tighten stop loss
4. Review forecast accuracy by source

### High Drawdown

**Symptoms:** > 20% max drawdown

**Solutions:**
1. Reduce `KELLY_FRACTION`
2. Tighten stop loss
3. Reduce `MAX_POSITION_SIZE`
4. Enable trailing stops

---

## Best Practices

1. **Start Conservative**: Begin with lower risk settings
2. **Gradual Changes**: Adjust one parameter at a time
3. **Document Everything**: Keep a log of changes and results
4. **Use Simulation**: Test changes before live trading
5. **Monitor Closely**: Watch metrics daily during tuning
6. **Have a Rollback Plan**: Know how to revert quickly

---

## Quick Reference

### Conservative Profile
```bash
MIN_EDGE_THRESHOLD=0.15
STOP_LOSS_THRESHOLD=-0.10
MAX_POSITION_SIZE=20
KELLY_FRACTION=0.15
ENABLE_CROSS_MARKET_ARBITRAGE=false
```

### Balanced Profile (Recommended)
```bash
MIN_EDGE_THRESHOLD=0.08
STOP_LOSS_THRESHOLD=-0.15
MAX_POSITION_SIZE=50
KELLY_FRACTION=0.25
ENABLE_CROSS_MARKET_ARBITRAGE=true
```

### Aggressive Profile
```bash
MIN_EDGE_THRESHOLD=0.05
STOP_LOSS_THRESHOLD=-0.20
MAX_POSITION_SIZE=100
KELLY_FRACTION=0.50
ENABLE_CROSS_MARKET_ARBITRAGE=true
```
