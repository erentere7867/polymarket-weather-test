/**
 * Telemetry Module
 * Tracks key performance metrics for the weather arbitrage bot
 */

import { logger } from '../logger.js';

export interface TradeMetrics {
    marketId: string;
    forecastTimestamp: Date;
    tradeTimestamp: Date;
    latencyMs: number;           // Time from forecast change to trade
    forecastValue: number;
    threshold: number;
    sigma: number;               // Standard deviations from threshold
    entryPrice: number;
    edge: number;
    isGuaranteed: boolean;
    outcome?: 'win' | 'loss' | 'pending';
    pnl?: number;
}

export interface TelemetryStats {
    totalTrades: number;
    wins: number;
    losses: number;
    pending: number;
    winRate: number;
    totalPnL: number;
    avgLatencyMs: number;
    avgEdge: number;
    tradesBySigma: { [sigma: string]: { count: number; wins: number; avgPnL: number } };
    edgeDecayAvgMs: number;      // How fast price catches up after forecast change
}

export class Telemetry {
    private trades: TradeMetrics[] = [];
    private edgeDecayMeasurements: number[] = []; // Time for price to reach fair value

    /**
     * Record a new trade
     */
    recordTrade(trade: TradeMetrics): void {
        this.trades.push(trade);

        logger.info(`📊 TELEMETRY: Trade recorded`, {
            marketId: trade.marketId.substring(0, 20),
            latencyMs: trade.latencyMs,
            sigma: trade.sigma.toFixed(1),
            edge: (trade.edge * 100).toFixed(1) + '%',
            isGuaranteed: trade.isGuaranteed,
        });
    }

    /**
     * Update trade outcome when known
     */
    updateOutcome(marketId: string, outcome: 'win' | 'loss', pnl: number): void {
        const trade = this.trades.find(t => t.marketId === marketId && t.outcome === 'pending');
        if (trade) {
            trade.outcome = outcome;
            trade.pnl = pnl;

            logger.info(`📊 TELEMETRY: Outcome updated`, {
                marketId: marketId.substring(0, 20),
                outcome,
                pnl: pnl.toFixed(2),
            });
        }
    }

    /**
     * Record how long it took for price to catch up to forecast
     */
    recordEdgeDecay(decayTimeMs: number): void {
        this.edgeDecayMeasurements.push(decayTimeMs);

        // Keep only last 100 measurements
        if (this.edgeDecayMeasurements.length > 100) {
            this.edgeDecayMeasurements.shift();
        }
    }

    /**
     * Get aggregated statistics
     */
    getStats(): TelemetryStats {
        const completedTrades = this.trades.filter(t => t.outcome && t.outcome !== 'pending');
        const wins = completedTrades.filter(t => t.outcome === 'win');
        const losses = completedTrades.filter(t => t.outcome === 'loss');
        const pending = this.trades.filter(t => !t.outcome || t.outcome === 'pending');

        const winRate = completedTrades.length > 0
            ? wins.length / completedTrades.length
            : 0;

        const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const avgLatencyMs = this.trades.length > 0
            ? this.trades.reduce((sum, t) => sum + t.latencyMs, 0) / this.trades.length
            : 0;
        const avgEdge = this.trades.length > 0
            ? this.trades.reduce((sum, t) => sum + t.edge, 0) / this.trades.length
            : 0;

        // Group by sigma ranges
        const tradesBySigma: { [sigma: string]: { count: number; wins: number; avgPnL: number } } = {
            '1.5-2.0': { count: 0, wins: 0, avgPnL: 0 },
            '2.0-3.0': { count: 0, wins: 0, avgPnL: 0 },
            '3.0+': { count: 0, wins: 0, avgPnL: 0 },
        };

        for (const trade of completedTrades) {
            let bucket: string;
            if (trade.sigma >= 3.0) bucket = '3.0+';
            else if (trade.sigma >= 2.0) bucket = '2.0-3.0';
            else bucket = '1.5-2.0';

            tradesBySigma[bucket].count++;
            if (trade.outcome === 'win') tradesBySigma[bucket].wins++;
            tradesBySigma[bucket].avgPnL += trade.pnl || 0;
        }

        // Calculate average PnL per bucket
        for (const bucket of Object.keys(tradesBySigma)) {
            if (tradesBySigma[bucket].count > 0) {
                tradesBySigma[bucket].avgPnL /= tradesBySigma[bucket].count;
            }
        }

        const edgeDecayAvgMs = this.edgeDecayMeasurements.length > 0
            ? this.edgeDecayMeasurements.reduce((a, b) => a + b, 0) / this.edgeDecayMeasurements.length
            : 0;

        return {
            totalTrades: this.trades.length,
            wins: wins.length,
            losses: losses.length,
            pending: pending.length,
            winRate,
            totalPnL,
            avgLatencyMs,
            avgEdge,
            tradesBySigma,
            edgeDecayAvgMs,
        };
    }

    /**
     * Print summary to log
     */
    printSummary(): void {
        const stats = this.getStats();

        logger.info('═'.repeat(50));
        logger.info('📊 TELEMETRY SUMMARY');
        logger.info('═'.repeat(50));
        logger.info(`Total Trades: ${stats.totalTrades}`);
        logger.info(`Win Rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W / ${stats.losses}L / ${stats.pending}P)`);
        logger.info(`Total PnL: $${stats.totalPnL.toFixed(2)}`);
        logger.info(`Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`);
        logger.info(`Avg Edge: ${(stats.avgEdge * 100).toFixed(1)}%`);
        logger.info(`Avg Edge Decay: ${(stats.edgeDecayAvgMs / 1000).toFixed(1)}s`);
        logger.info('─'.repeat(50));
        logger.info('By Sigma Level:');
        for (const [sigma, data] of Object.entries(stats.tradesBySigma)) {
            if (data.count > 0) {
                const sigmaWinRate = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : 0;
                logger.info(`  ${sigma}σ: ${data.count} trades, ${sigmaWinRate}% win rate, $${data.avgPnL.toFixed(2)} avg PnL`);
            }
        }
        logger.info('═'.repeat(50));
    }

    /**
     * Get all trade history
     */
    getTradeHistory(): TradeMetrics[] {
        return [...this.trades];
    }

    /**
     * Clear all data (for testing)
     */
    clear(): void {
        this.trades = [];
        this.edgeDecayMeasurements = [];
    }
}

// Singleton instance
export const telemetry = new Telemetry();
