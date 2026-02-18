/**
 * Portfolio Simulator
 * Tracks a simulated portfolio with positions, PnL, and cash
 */

import { logger } from '../logger.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';

export interface SimulatedPosition {
    id: string;
    marketId: string;
    marketQuestion: string;
    tokenId: string;
    side: 'yes' | 'no';
    shares: number;
    entryPrice: number;
    currentPrice: number;
    entryTime: Date;
    targetDate?: Date;
    city?: string;
    metricType?: string;
    unrealizedPnL: number;
    status: 'open' | 'closed' | 'expired';
    exitPrice?: number;
    exitTime?: Date;
    realizedPnL?: number;
    sigma?: number;
    signalType?: 'forecast_change' | 'high_confidence' | 'standard';
    entryForecastValue?: number;
}

export interface PortfolioStats {
    startingCash: number;
    currentCash: number;
    totalValue: number;
    unrealizedPnL: number;
    realizedPnL: number;
    totalPnL: number;
    totalPnLPercent: number;
    openPositions: number;
    closedPositions: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    averageWin: number;
    averageLoss: number;
    largestWin: number;
    largestLoss: number;
    currentExposure: number;
    maxDrawdown: number;
    
    // New: Kelly heat management stats
    kellyHeat: number;
    kellyHeatPercent: number;
    maxKellyHeat: number;
    exposurePercent: number;
    cashReservePercent: number;
    recentWinRate: number;  // Last 20 trades
    avgEdgeRealized: number;  // Average edge on realized trades
}

export interface TradeRecord {
    id: string;
    timestamp: Date;
    action: 'buy' | 'sell';
    marketQuestion: string;
    side: 'yes' | 'no';
    shares: number;
    price: number;
    value: number;
    reason: string;
    pnl?: number;
    kellyFraction?: number;
    edge?: number;
}

export interface KellyPortfolioConfig {
    maxTotalExposure: number;      // Max % of portfolio in positions
    maxKellyHeat: number;          // Max sum of Kelly fractions
    minCashReserve: number;        // Minimum % cash reserve
    concentrationFactor: number;   // Multiplier for concentration
    correlationPenalty: number;    // Penalty per correlated position
}

export class PortfolioSimulator {
    private startingCash: number;
    private cash: number;
    private positions: Map<string, SimulatedPosition> = new Map();
    private closedPositions: SimulatedPosition[] = [];
    private tradeHistory: TradeRecord[] = [];
    private peakValue: number;
    private maxDrawdown: number = 0;

    // Exposure caps for confidence compression strategy
    private maxExposurePerCity: number = 500;   // $500 max per city
    private maxExposurePerMarketDay: number = 100;    // $100 max per market day
    private cityExposure: Map<string, number> = new Map();
    private marketDayExposure: Map<string, number> = new Map(); // key: city:date
    
    // Kelly-based portfolio heat management
    private kellyPortfolioConfig: KellyPortfolioConfig = {
        maxTotalExposure: 0.50,      // Max 50% of portfolio in open positions
        maxKellyHeat: 0.30,          // Max 30% Kelly sum across all positions
        minCashReserve: 0.10,        // Minimum 10% cash reserve
        concentrationFactor: 1.5,    // Allow concentration in best opportunities
        correlationPenalty: 0.10     // Penalty per correlated position
    };
    
    // Track position Kelly fractions for heat calculation
    private positionKellyFractions: Map<string, number> = new Map();
    
    // Track realized performance for Kelly adjustment
    private recentTrades: { pnl: number; edge: number; timestamp: Date }[] = [];
    private readonly MAX_RECENT_TRADES = 50;

    constructor(startingCash: number = 10000) {
        this.startingCash = startingCash;
        this.cash = startingCash;
        this.peakValue = startingCash;
    }


    /**
     * Check Kelly-based heat constraints
     */
    private checkKellyHeat(
        positionSize: number,
        kellyFraction: number,
        opportunity: TradingOpportunity
    ): { allowed: boolean; adjustedSize: number; reason?: string } {
        const portfolioValue = this.getTotalValue();
        const currentExposure = this.getCurrentExposure();
        const kellyHeat = this.getKellyHeat();
        
        // Check 1: Total exposure limit
        const exposureAfterTrade = currentExposure + positionSize;
        const exposureRatio = exposureAfterTrade / portfolioValue;
        
        if (exposureRatio > this.kellyPortfolioConfig.maxTotalExposure) {
            // Scale down to fit within exposure limit
            const maxAllowedExposure = portfolioValue * this.kellyPortfolioConfig.maxTotalExposure;
            const adjustedSize = Math.max(0, maxAllowedExposure - currentExposure);
            
            if (adjustedSize < 5) {
                return { allowed: false, adjustedSize: 0, reason: 'Max portfolio exposure reached' };
            }
            
            return { allowed: true, adjustedSize, reason: 'Scaled to fit exposure limit' };
        }
        
        // Check 2: Kelly heat limit
        const kellyAfterTrade = kellyHeat + kellyFraction;
        
        if (kellyAfterTrade > this.kellyPortfolioConfig.maxKellyHeat) {
            // Scale down Kelly fraction
            const maxAdditionalKelly = this.kellyPortfolioConfig.maxKellyHeat - kellyHeat;
            const kellyRatio = Math.max(0.1, maxAdditionalKelly / kellyFraction);
            const adjustedSize = positionSize * kellyRatio;
            
            if (adjustedSize < 5) {
                return { allowed: false, adjustedSize: 0, reason: 'Max Kelly heat reached' };
            }
            
            return { allowed: true, adjustedSize, reason: 'Scaled to fit Kelly heat limit' };
        }
        
        // Check 3: Cash reserve limit
        const cashAfterTrade = this.cash - positionSize;
        const cashReserveRatio = cashAfterTrade / portfolioValue;
        
        if (cashReserveRatio < this.kellyPortfolioConfig.minCashReserve) {
            const minCash = portfolioValue * this.kellyPortfolioConfig.minCashReserve;
            const adjustedSize = Math.max(0, this.cash - minCash);
            
            if (adjustedSize < 5) {
                return { allowed: false, adjustedSize: 0, reason: 'Minimum cash reserve required' };
            }
            
            return { allowed: true, adjustedSize, reason: 'Scaled to maintain cash reserve' };
        }
        
        // Check 4: Concentration bonus for high-edge opportunities
        if (opportunity.edge > 0.10 && kellyFraction > 0.20) {
            const boostedSize = positionSize * this.kellyPortfolioConfig.concentrationFactor;
            return { allowed: true, adjustedSize: boostedSize, reason: 'Concentration bonus applied' };
        }
        
        return { allowed: true, adjustedSize: positionSize };
    }

    /**
     * Get current total exposure
     */
    private getCurrentExposure(): number {
        let exposure = 0;
        for (const position of this.positions.values()) {
            if (position.status === 'open') {
                exposure += position.shares * position.entryPrice;
            }
        }
        return exposure;
    }

    /**
     * Get current Kelly heat (sum of all position Kelly fractions)
     */
    private getKellyHeat(): number {
        let heat = 0;
        for (const kelly of this.positionKellyFractions.values()) {
            heat += kelly;
        }
        return heat;
    }

    /**
     * Record trade result for Kelly adjustment
     */
    recordTradeResult(pnl: number, edge: number): void {
        this.recentTrades.push({
            pnl,
            edge,
            timestamp: new Date()
        });
        
        // Keep only recent trades
        if (this.recentTrades.length > this.MAX_RECENT_TRADES) {
            this.recentTrades.shift();
        }
    }

    /**
     * Open a new position based on opportunity
     * Enhanced with Kelly-based heat management
     */
    openPosition(
        opportunity: TradingOpportunity,
        maxPositionSize: number = 10000,
        kellyFraction: number = 0.25
    ): SimulatedPosition | null {
        if (opportunity.action === 'none') {
            return null;
        }

        // Calculate position size - prioritize the provided maxPositionSize (which comes from signal size)
        // This ensures we use the EntryOptimizer's calculated size
        const edge = Math.abs(opportunity.edge);
        const confidence = opportunity.confidence;

        // Use the provided maxPositionSize as the target (from EntryOptimizer)
        // But also apply Kelly-inspired scaling for very small edges
        let positionValue: number;

        if (maxPositionSize > 0 && maxPositionSize < 100000) {
            // Use the signal size directly if it seems reasonable (from EntryOptimizer)
            positionValue = Math.min(maxPositionSize, this.cash * 0.5); // Max 50% of cash
        } else {
            // Fallback to Kelly calculation
            const sizingFactor = Math.min(edge * confidence * 2, 0.05); // Max 5% of portfolio per trade
            const portfolioValue = this.getTotalValue();
            positionValue = Math.min(
                portfolioValue * sizingFactor,
                maxPositionSize,
                this.cash * 0.2 // Max 20% of available cash per trade
            );
        }

        // Apply Kelly-based heat management
        const heatCheck = this.checkKellyHeat(positionValue, kellyFraction, opportunity);
        if (!heatCheck.allowed) {
            logger.warn(`Position rejected: ${heatCheck.reason}`, {
                edge: `${(edge * 100).toFixed(1)}%`,
                kellyFraction: `${(kellyFraction * 100).toFixed(1)}%`
            });
            return null;
        }
        
        // Use adjusted size if needed
        if (heatCheck.adjustedSize < positionValue) {
            logger.info(`Position scaled: ${heatCheck.reason}`, {
                original: `$${positionValue.toFixed(2)}`,
                adjusted: `$${heatCheck.adjustedSize.toFixed(2)}`
            });
            positionValue = heatCheck.adjustedSize;
        } else if (heatCheck.adjustedSize > positionValue) {
            // Concentration bonus
            positionValue = heatCheck.adjustedSize;
        }

        // Lower minimum position size to $5 (was $10) to capture more opportunities
        if (positionValue < 5) {
            logger.warn(`Position size too small ($${positionValue.toFixed(2)}), skipping`);
            return null;
        }

        if (this.cash < positionValue) {
            logger.warn('Insufficient cash for position', {
                required: positionValue.toFixed(2),
                available: this.cash.toFixed(2)
            });
            return null;
        }

        const isBuyYes = opportunity.action === 'buy_yes';
        const basePrice = isBuyYes ? opportunity.market.yesPrice : opportunity.market.noPrice;

        if (basePrice <= 0 || basePrice >= 1) {
            logger.warn(`Invalid base price for execution: ${basePrice}, skipping`);
            return null;
        }

        // SIMULATED EXECUTION
        // 1. Add Slippage (based on position size)
        // Small trade ($100) -> 0.1% slippage
        // Large trade ($10k) -> 1-5% slippage depending on liquidity
        // Model: Impact = k * sqrt(Size)
        const liquidityFactor = 200000; // Simulated liquidity depth
        const priceImpact = (positionValue / liquidityFactor) * 0.1;
        const executionPrice = Math.min(0.99, Math.max(0.01, basePrice + (isBuyYes ? priceImpact : -priceImpact)));

        // 2. Add Fees (Polymarket CTF = 0% usually, but let's be conservative or add gas equivalent)
        const feeRate = 0.00; // 0% fees on Polymarket currently for taker
        const fees = positionValue * feeRate;

        const shares = Math.floor((positionValue - fees) / executionPrice);
        const actualCost = shares * executionPrice;

        const position: SimulatedPosition = {
            id: `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            marketId: opportunity.market.market.id,
            marketQuestion: opportunity.market.market.question,
            tokenId: isBuyYes ? opportunity.market.yesTokenId : opportunity.market.noTokenId,
            side: isBuyYes ? 'yes' : 'no',
            shares,
            entryPrice: executionPrice, // Actual filled price
            currentPrice: executionPrice,
            entryTime: new Date(),
            targetDate: opportunity.market.targetDate,
            city: opportunity.market.city || undefined,
            metricType: opportunity.market.metricType,
            unrealizedPnL: -Math.abs(actualCost - (shares * basePrice)), // Immediate loss due to slippage
            status: 'open',
        };

        // Deduct cash and track Kelly fraction
        this.cash -= actualCost;
        this.positions.set(position.id, position);
        this.positionKellyFractions.set(position.id, kellyFraction);
        
        // Track exposure
        this.trackExposure(opportunity.market.city || 'unknown', opportunity.market.targetDate, actualCost);

        // Record trade with Kelly fraction and edge
        this.tradeHistory.push({
            id: `trade_${Date.now()}`,
            timestamp: new Date(),
            action: 'buy',
            marketQuestion: opportunity.market.market.question,
            side: position.side,
            shares,
            price: executionPrice,
            value: actualCost,
            reason: opportunity.reason,
            kellyFraction,
            edge: opportunity.edge
        });

        logger.info(`📈 Opened position: ${position.side.toUpperCase()} ${shares} shares @ $${executionPrice.toFixed(3)}`, {
            market: opportunity.market.market.question.substring(0, 50),
            cost: `$${actualCost.toFixed(2)}`,
            edge: `${(edge * 100).toFixed(1)}%`,
            remainingCash: `$${this.cash.toFixed(2)}`,
        });

        this.updateDrawdown();
        return position;
    }

    /**
     * Update position with new market price
     */
    updatePositionPrice(positionId: string, newPrice: number): void {
        const position = this.positions.get(positionId);
        if (!position || position.status !== 'open') return;

        position.currentPrice = newPrice;
        position.unrealizedPnL = (newPrice - position.entryPrice) * position.shares;
        this.updateDrawdown();
    }

    /**
     * Update all positions by token ID
     */
    updatePriceByToken(tokenId: string, newPrice: number): void {
        for (const [id, position] of this.positions) {
            if (position.tokenId === tokenId && position.status === 'open') {
                this.updatePositionPrice(id, newPrice);
            }
        }
    }

    /**
     * Close a position (sell)
     */
    closePosition(positionId: string, exitPrice: number, reason: string = 'Manual close'): SimulatedPosition | null {
        const position = this.positions.get(positionId);
        if (!position || position.status !== 'open') return null;

        const exitValue = position.shares * exitPrice;
        const pnl = (exitPrice - position.entryPrice) * position.shares;

        position.status = 'closed';
        position.exitPrice = exitPrice;
        position.exitTime = new Date();
        position.realizedPnL = pnl;
        position.currentPrice = exitPrice;
        position.unrealizedPnL = 0;

        // Add cash back
        this.cash += exitValue;

        // Move to closed positions
        this.closedPositions.push(position);
        this.positions.delete(positionId);
        
        // Clean up Kelly fraction tracking
        const kellyFraction = this.positionKellyFractions.get(positionId) || 0;
        this.positionKellyFractions.delete(positionId);
        
        // Record trade result for Kelly adjustment
        this.recordTradeResult(pnl, 0);  // Edge not available on close

        // Record trade
        this.tradeHistory.push({
            id: `trade_${Date.now()}`,
            timestamp: new Date(),
            action: 'sell',
            marketQuestion: position.marketQuestion,
            side: position.side,
            shares: position.shares,
            price: exitPrice,
            value: exitValue,
            reason,
            pnl,
        });

        const pnlSign = pnl >= 0 ? '📈' : '📉';
        logger.info(`${pnlSign} Closed position: ${position.side.toUpperCase()} ${position.shares} shares @ $${exitPrice.toFixed(3)}`, {
            market: position.marketQuestion.substring(0, 50),
            entryPrice: `$${position.entryPrice.toFixed(3)}`,
            exitPrice: `$${exitPrice.toFixed(3)}`,
            pnl: `$${pnl.toFixed(2)}`,
            pnlPercent: `${((pnl / (position.entryPrice * position.shares)) * 100).toFixed(1)}%`,
        });

        this.updateDrawdown();
        return position;
    }

    /**
     * Simulate market resolution (contract expires at 0 or 1)
     */
    resolvePosition(positionId: string, outcome: 'yes' | 'no'): SimulatedPosition | null {
        const position = this.positions.get(positionId);
        if (!position || position.status !== 'open') return null;

        // If we bet on YES and outcome is YES, we get $1 per share
        // If we bet on YES and outcome is NO, we get $0 per share
        const won = position.side === outcome;
        const exitPrice = won ? 1.0 : 0.0;

        return this.closePosition(positionId, exitPrice, `Market resolved: ${outcome.toUpperCase()}`);
    }

    /**
     * Auto-close positions that should be exited (profit taking, stop loss, expiry)
     * OPTIMIZED: 8% take profit for better R:R, 10% stop loss
     */
    autoClosePositions(
        takeProfitThreshold: number = 0.08,  // 8% profit - balanced scalping
        stopLossThreshold: number = -0.10    // 10% loss - tight risk management
    ): SimulatedPosition[] {
        const closed: SimulatedPosition[] = [];

        for (const [id, position] of this.positions) {
            if (position.status !== 'open') continue;

            const pnlPercent = (position.currentPrice - position.entryPrice) / position.entryPrice;

            // Take profit
            if (pnlPercent >= takeProfitThreshold) {
                const result = this.closePosition(id, position.currentPrice, 'Take profit triggered');
                if (result) closed.push(result);
                continue;
            }

            // Stop loss
            if (pnlPercent <= stopLossThreshold) {
                const result = this.closePosition(id, position.currentPrice, 'Stop loss triggered');
                if (result) closed.push(result);
                continue;
            }

            // Check for expired markets
            if (position.targetDate && new Date() > position.targetDate) {
                // Simulate random resolution for testing
                const outcome = Math.random() > 0.5 ? 'yes' : 'no';
                const result = this.resolvePosition(id, outcome as 'yes' | 'no');
                if (result) closed.push(result);
            }
        }

        return closed;
    }

    /**
     * Get total portfolio value
     */
    getTotalValue(): number {
        let positionValue = 0;
        for (const position of this.positions.values()) {
            if (position.status === 'open') {
                positionValue += position.shares * position.currentPrice;
            }
        }
        return this.cash + positionValue;
    }

    /**
     * Get portfolio statistics
     */
    getStats(): PortfolioStats {
        const totalValue = this.getTotalValue();

        let unrealizedPnL = 0;
        let currentExposure = 0;
        for (const position of this.positions.values()) {
            if (position.status === 'open') {
                unrealizedPnL += position.unrealizedPnL;
                currentExposure += position.shares * position.entryPrice;
            }
        }

        let realizedPnL = 0;
        let winningTrades = 0;
        let losingTrades = 0;
        let totalWins = 0;
        let totalLosses = 0;
        let largestWin = 0;
        let largestLoss = 0;

        for (const position of this.closedPositions) {
            const pnl = position.realizedPnL || 0;
            realizedPnL += pnl;

            if (pnl > 0) {
                winningTrades++;
                totalWins += pnl;
                largestWin = Math.max(largestWin, pnl);
            } else if (pnl < 0) {
                losingTrades++;
                totalLosses += Math.abs(pnl);
                largestLoss = Math.min(largestLoss, pnl);
            }
        }

        const totalTrades = winningTrades + losingTrades;
        const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
        const averageWin = winningTrades > 0 ? totalWins / winningTrades : 0;
        const averageLoss = losingTrades > 0 ? totalLosses / losingTrades : 0;
        const totalPnL = realizedPnL + unrealizedPnL;
        const totalPnLPercent = (totalPnL / this.startingCash) * 100;
        
        // Calculate Kelly heat and exposure
        const kellyHeat = this.getKellyHeat();
        const maxKellyHeat = this.kellyPortfolioConfig.maxKellyHeat;
        const kellyHeatPercent = (kellyHeat / maxKellyHeat) * 100;
        const exposurePercent = (currentExposure / totalValue) * 100;
        const cashReservePercent = (this.cash / totalValue) * 100;
        
        // Calculate recent win rate (last 20 trades)
        const recentTrades = this.recentTrades.slice(-20);
        const recentWins = recentTrades.filter(t => t.pnl > 0).length;
        const recentWinRate = recentTrades.length > 0 ? (recentWins / recentTrades.length) * 100 : winRate;
        
        // Calculate average edge realized
        const tradesWithEdge = this.recentTrades.filter(t => t.edge !== undefined);
        const avgEdgeRealized = tradesWithEdge.length > 0
            ? tradesWithEdge.reduce((sum, t) => sum + (t.edge || 0), 0) / tradesWithEdge.length
            : 0;

        return {
            startingCash: this.startingCash,
            currentCash: this.cash,
            totalValue,
            unrealizedPnL,
            realizedPnL,
            totalPnL,
            totalPnLPercent,
            openPositions: this.positions.size,
            closedPositions: this.closedPositions.length,
            winningTrades,
            losingTrades,
            winRate,
            averageWin,
            averageLoss,
            largestWin,
            largestLoss,
            currentExposure,
            maxDrawdown: this.maxDrawdown,
            // New: Kelly heat stats
            kellyHeat,
            kellyHeatPercent,
            maxKellyHeat,
            exposurePercent,
            cashReservePercent,
            recentWinRate,
            avgEdgeRealized
        };
    }

    /**
     * Update max drawdown
     */
    private updateDrawdown(): void {
        const currentValue = this.getTotalValue();
        if (currentValue > this.peakValue) {
            this.peakValue = currentValue;
        }

        const drawdown = (this.peakValue - currentValue) / this.peakValue;
        if (drawdown > this.maxDrawdown) {
            this.maxDrawdown = drawdown;
        }
    }

    /**
     * Get open positions
     */
    getOpenPositions(): SimulatedPosition[] {
        return Array.from(this.positions.values()).filter(p => p.status === 'open');
    }

    /**
     * Get closed positions
     */
    getClosedPositions(): SimulatedPosition[] {
        return this.closedPositions;
    }

    /**
     * Get trade history
     */
    getTradeHistory(): TradeRecord[] {
        return this.tradeHistory;
    }

    /**
     * Print portfolio summary to console
     */
    printSummary(): void {
        const stats = this.getStats();
        const pnlSign = stats.totalPnL >= 0 ? '+' : '';

        console.log('\n' + '═'.repeat(70));
        console.log('                        PORTFOLIO SUMMARY');
        console.log('═'.repeat(70));

        console.log(`\n💰 CASH & VALUE`);
        console.log(`   Starting Capital:    $${stats.startingCash.toLocaleString()}`);
        console.log(`   Current Cash:        $${stats.currentCash.toLocaleString()}`);
        console.log(`   Portfolio Value:     $${stats.totalValue.toLocaleString()}`);
        console.log(`   Current Exposure:    $${stats.currentExposure.toLocaleString()}`);

        console.log(`\n📊 PROFIT & LOSS`);
        console.log(`   Unrealized P&L:      ${stats.unrealizedPnL >= 0 ? '+' : ''}$${stats.unrealizedPnL.toLocaleString()}`);
        console.log(`   Realized P&L:        ${stats.realizedPnL >= 0 ? '+' : ''}$${stats.realizedPnL.toLocaleString()}`);
        console.log(`   Total P&L:           ${pnlSign}$${stats.totalPnL.toLocaleString()} (${pnlSign}${stats.totalPnLPercent.toFixed(2)}%)`);
        console.log(`   Max Drawdown:        -${(stats.maxDrawdown * 100).toFixed(2)}%`);

        console.log(`\n📈 TRADING STATS`);
        console.log(`   Open Positions:      ${stats.openPositions}`);
        console.log(`   Closed Positions:    ${stats.closedPositions}`);
        console.log(`   Win Rate:            ${stats.winRate.toFixed(1)}%`);
        console.log(`   Winning Trades:      ${stats.winningTrades}`);
        console.log(`   Losing Trades:       ${stats.losingTrades}`);
        console.log(`   Average Win:         $${stats.averageWin.toFixed(2)}`);
        console.log(`   Average Loss:        $${stats.averageLoss.toFixed(2)}`);
        console.log(`   Largest Win:         $${stats.largestWin.toFixed(2)}`);
        console.log(`   Largest Loss:        $${stats.largestLoss.toFixed(2)}`);

        if (this.getOpenPositions().length > 0) {
            console.log(`\n📋 OPEN POSITIONS`);
            for (const pos of this.getOpenPositions()) {
                const pnlStr = pos.unrealizedPnL >= 0 ? `+$${pos.unrealizedPnL.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnL).toFixed(2)}`;
                console.log(`   • ${pos.side.toUpperCase()} ${pos.shares} @ $${pos.entryPrice.toFixed(3)} → $${pos.currentPrice.toFixed(3)} (${pnlStr})`);
                console.log(`     ${pos.marketQuestion.substring(0, 60)}...`);
            }
        }

        console.log('\n' + '═'.repeat(70));
    }

    /**
     * Export portfolio data as JSON
     */
    toJSON(): object {
        return {
            stats: this.getStats(),
            openPositions: this.getOpenPositions(),
            closedPositions: this.closedPositions,
            tradeHistory: this.tradeHistory,
        };
    }

    /**
     * Get portfolio stats (alias for API)
     */
    getPortfolio(): PortfolioStats {
        return this.getStats();
    }
    /**
     * Get all positions (alias for consistency)
     */
    getAllPositions(): SimulatedPosition[] {
        return Array.from(this.positions.values());
    }

    /**
     * Get cash balance
     */
    getCashBalance(): number {
        return this.cash;
    }

    /**
     * Check for closures (alias for autoClosePositions)
     */
    checkClosures(): void {
        this.autoClosePositions();
    }

    /**
     * Update prices from market data
     */
    updatePrices(markets: ParsedWeatherMarket[]): void {
        for (const market of markets) {
            this.updatePriceByToken(market.yesTokenId, market.yesPrice);
            this.updatePriceByToken(market.noTokenId, market.noPrice);
        }
    }

    // ============================================================================
    // EXPOSURE CAP METHODS (Confidence Compression Strategy)
    // ============================================================================

    /**
     * Check if a position would exceed city exposure cap
     */
    wouldExceedCityExposure(city: string, amount: number): boolean {
        const normalized = city?.toLowerCase().trim() || 'unknown';
        const current = this.cityExposure.get(normalized) || 0;
        return (current + amount) > this.maxExposurePerCity;
    }

    /**
     * Check if a position would exceed market-day exposure cap
     */
    wouldExceedMarketDayExposure(city: string, targetDate: Date, amount: number): boolean {
        const dateStr = targetDate?.toISOString().split('T')[0] || 'unknown';
        const key = `${city?.toLowerCase().trim() || 'unknown'}:${dateStr}`;
        const current = this.marketDayExposure.get(key) || 0;
        return (current + amount) > this.maxExposurePerMarketDay;
    }

    /**
     * Get available exposure for a city (how much more can be invested)
     */
    getAvailableCityExposure(city: string): number {
        const normalized = city?.toLowerCase().trim() || 'unknown';
        const current = this.cityExposure.get(normalized) || 0;
        return Math.max(0, this.maxExposurePerCity - current);
    }

    /**
     * Get available exposure for a market-day
     */
    getAvailableMarketDayExposure(city: string, targetDate: Date): number {
        const dateStr = targetDate?.toISOString().split('T')[0] || 'unknown';
        const key = `${city?.toLowerCase().trim() || 'unknown'}:${dateStr}`;
        const current = this.marketDayExposure.get(key) || 0;
        return Math.max(0, this.maxExposurePerMarketDay - current);
    }

    /**
     * Update exposure tracking when opening a position
     */
    trackExposure(city: string, targetDate: Date | undefined, amount: number): void {
        const normalized = city?.toLowerCase().trim() || 'unknown';

        // Track city exposure
        const currentCity = this.cityExposure.get(normalized) || 0;
        this.cityExposure.set(normalized, currentCity + amount);

        // Track market-day exposure
        if (targetDate) {
            const dateStr = targetDate.toISOString().split('T')[0];
            const key = `${normalized}:${dateStr}`;
            const currentDay = this.marketDayExposure.get(key) || 0;
            this.marketDayExposure.set(key, currentDay + amount);
        }
    }

    /**
     * Release exposure when closing a position
     */
    releaseExposure(city: string, targetDate: Date | undefined, amount: number): void {
        const normalized = city?.toLowerCase().trim() || 'unknown';

        // Release city exposure
        const currentCity = this.cityExposure.get(normalized) || 0;
        this.cityExposure.set(normalized, Math.max(0, currentCity - amount));

        // Release market-day exposure
        if (targetDate) {
            const dateStr = targetDate.toISOString().split('T')[0];
            const key = `${normalized}:${dateStr}`;
            const currentDay = this.marketDayExposure.get(key) || 0;
            this.marketDayExposure.set(key, Math.max(0, currentDay - amount));
        }
    }

    /**
     * Set exposure caps
     */
    setExposureCaps(perCity: number, perMarketDay: number): void {
        this.maxExposurePerCity = perCity;
        this.maxExposurePerMarketDay = perMarketDay;
    }

    /**
     * Get exposure summary
     */
    getExposureSummary(): {
        byCity: Record<string, number>;
        byMarketDay: Record<string, number>;
        caps: { perCity: number; perMarketDay: number };
    } {
        return {
            byCity: Object.fromEntries(this.cityExposure),
            byMarketDay: Object.fromEntries(this.marketDayExposure),
            caps: {
                perCity: this.maxExposurePerCity,
                perMarketDay: this.maxExposurePerMarketDay,
            },
        };
    }
}
