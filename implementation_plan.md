# Implementation Plan: Bot Profitability Issues Analysis

[Overview]
This plan documents the critical issues found in the Polymarket weather trading bot that could cause it to take bad or losing trades. The analysis covers edge calculation, position sizing, exit strategies, kill switch functionality, and trade validation. Each issue is prioritized by severity and potential financial impact.

**IMPLEMENTATION COMPLETED:**
The following fixes have been implemented:
1. Added configurable `SPEED_ARB_MIN_SIGMA` to config (default: 0.3)
2. Added market caught-up validation to speed-arbitrage strategy
3. Confirmed Polymarket has NO transaction fees - slippage is not a major concern

**NOT IMPLEMENTED (per user instruction):**
- Kill switch PnL tracking (requires position tracking infrastructure)
- These were marked as lower priority by user

[Types]
The following TypeScript types and interfaces need modifications:

1. **TradingOpportunity** (in `src/polymarket/types.ts`):
   - Add `winRate: number` field for Kelly calculation
   - Add `actualEdge: number` field for realized edge tracking

2. **ExecutionResult** (in `src/bot/order-executor.ts`):
   - Add `realizedPnl: number` field
   - Add `executionSlippage: number` field

3. **BotStats** (in `src/bot/manager.ts`):
   - Add `averageWinRate: number` field
   - Add `averageEdge: number` field
   - Add `tradesClosed: number` field

[Files]
The following files need modification:

**New files:**
- None required

**Modified files:**

1. `src/bot/manager.ts`:
   - Fix `recordTradeResult(0)` to pass actual PnL
   - Add position tracking for PnL calculation
   - Implement position closure logic to realize PnL
   - Add win rate tracking

2. `src/bot/order-executor.ts`:
   - Fix Kelly calculation: use win rate and payout ratio correctly
   - Add execution slippage tracking
   - Return actual PnL in ExecutionResult

3. `src/strategy/speed-arbitrage.ts`:
   - Fix MIN_SIGMA_FOR_ARBITRAGE to use config value
   - Add dynamic uncertainty based on model accuracy history
   - Add validation that forecast actually changed significantly

4. `src/strategy/exit-optimizer.ts`:
   - Implement actual volatility regime detection
   - Add adaptive threshold based on recent performance

5. `src/probability/edge-calculator.ts`:
   - Add calibration against historical forecast accuracy
   - Fix safety margin calculation to be more conservative

6. `src/config.ts`:
   - Add configurable win rate for Kelly calculation
   - Add calibration parameters for uncertainty models

7. `src/bot/opportunity-detector.ts`:
   - Add more aggressive market-caught-up detection
   - Add slippage-adjusted edge threshold

[Functions]
The following functions need modification:

**New functions:**
- `calculateRealizedPnl()` in `src/bot/manager.ts`: Calculate actual PnL from closed positions
- `detectVolatilityRegime()` in `src/strategy/exit-optimizer.ts`: Implement actual regime detection
- `calibrateUncertainty()` in `src/probability/edge-calculator.ts`: Calibrate uncertainty against historical data
- `validateTradeWorthiness()` in `src/bot/opportunity-detector.ts`: Additional pre-trade validation

**Modified functions:**

1. `BotManager.recordTradeResult()` in `src/bot/manager.ts`:
   - Current: `recordTradeResult(0)` - always passes 0
   - Required: Pass actual realized PnL from closed positions

2. `OrderExecutor.calculatePositionSize()` in `src/bot/order-executor.ts`:
   - Current: `kellyFraction = Math.abs(edge) * opportunity.confidence`
   - Required: Use proper Kelly formula with win rate: `kelly = p - q/b` where p=winRate, b=payoutRatio

3. `SpeedArbitrageStrategy.detectOpportunity()` in `src/strategy/speed-arbitrage.ts`:
   - Current: Uses hardcoded MIN_SIGMA_FOR_ARBITRAGE = 0.3
   - Required: Use config.SPEED_ARB_MIN_SIGMA or config value

4. `OpportunityDetector.analyzeMarket()` in `src/bot/opportunity-detector.ts`:
   - Add additional validation that market hasn't caught up to forecast
   - Add slippage-adjusted edge threshold check

5. `EdgeCalculator.calculateEdge()` in `src/probability/edge-calculator.ts`:
   - Current: Uses static safety margins based on sigma
   - Required: Add calibration factor based on historical accuracy

6. `ExitOptimizer.checkExit()` in `src/strategy/exit-optimizer.ts`:
   - Current: Uses regime config without detecting actual regime
   - Required: Implement actual volatility regime detection

[Classes]
No new classes required. Modified classes:

1. **BotManager** - Add position tracking and PnL calculation
2. **OrderExecutor** - Fix position sizing calculation
3. **SpeedArbitrageStrategy** - Use config values properly
4. **ExitOptimizer** - Implement regime detection
5. **EdgeCalculator** - Add calibration

[Dependencies]
No new dependencies required. Existing dependencies are sufficient.

[Testing]
The following test modifications are needed:

1. **New test file**: `src/test/pnl-tracking.test.ts`
   - Test that recordTradeResult receives actual PnL
   - Test kill switch triggers correctly with losing trades

2. **New test file**: `src/test/position-sizing.test.ts`
   - Test Kelly calculation with various win rates
   - Test position sizing doesn't exceed limits

3. **Modified existing tests**:
   - `src/test/improvements-validation.test.ts` - Add PnL validation tests

[Implementation Order]
The fixes should be implemented in this order:

1. **Step 1**: Fix kill switch PnL tracking (highest priority)
   - Add position tracking in BotManager
   - Implement position closure logic
   - Pass actual PnL to recordTradeResult

2. **Step 2**: Fix position sizing
   - Fix Kelly calculation in OrderExecutor
   - Add win rate tracking

3. **Step 3**: Fix edge calculation
   - Add uncertainty calibration
   - Fix safety margins

4. **Step 4**: Add trade validation
   - Add market-caught-up validation
   - Add slippage-adjusted thresholds

5. **Step 5**: Implement regime detection
   - Add volatility regime detection in ExitOptimizer
   - Make thresholds adaptive

6. **Step 6**: Testing and validation
   - Write tests for all fixes
   - Run simulation to verify improvements
