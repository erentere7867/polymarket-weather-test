import { DataStore } from '../realtime/data-store.js';
import { MarketModel } from '../probability/market-model.js';
import { EdgeCalculator } from '../probability/edge-calculator.js';
import { EntryOptimizer, EntrySignal } from './entry-optimizer.js';
import { normalCDF } from '../probability/normal-cdf.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';

export interface HybridSignal extends EntrySignal {
    signalType: 'forecast_change' | 'high_confidence';
    confidence: number;
    crossMarketSignals?: HybridSignal[];
}

interface HybridRejectionStats {
    totalChecked: number;
    noMarketState: number;
    noForecast: number;
    noThreshold: number;
    noPriceHistory: number;
    errors: number;
}

export class HybridTradingStrategy {
    private store: DataStore;
    private marketModel: MarketModel;
    private edgeCalculator: EdgeCalculator;
    private entryOptimizer: EntryOptimizer;
    
    private lastForecastValues: Map<string, number> = new Map();
    
    private rejectionStats: HybridRejectionStats = {
        totalChecked: 0,
        noMarketState: 0,
        noForecast: 0,
        noThreshold: 0,
        noPriceHistory: 0,
        errors: 0,
    };
    private lastRejectionLogTime: number = 0;
    
    private readonly MIN_CONFIDENCE_THRESHOLD = 0.50;
    
    constructor(store: DataStore) {
        this.store = store;
        this.marketModel = new MarketModel(store);
        this.edgeCalculator = new EdgeCalculator(this.marketModel);
        this.entryOptimizer = new EntryOptimizer(config.maxPositionSize);
    }
    
    detectOpportunities(): HybridSignal[] {
        const markets = this.store.getAllMarkets();
        const signals: HybridSignal[] = [];
        const processedCities = new Set<string>();
        
        const marketsByCity = this.groupMarketsByCity(markets);
        
        for (const [city, cityMarkets] of marketsByCity.entries()) {
            try {
                const changeSignals = this.detectForecastChangeForCity(city, cityMarkets);
                if (changeSignals.length > 0) {
                    signals.push(...changeSignals);
                    processedCities.add(city);
                    continue;
                }
                
                if (!processedCities.has(city)) {
                    for (const market of cityMarkets) {
                        const confidenceSignal = this.detectHighConfidenceSignal(market);
                        if (confidenceSignal) {
                            signals.push(confidenceSignal);
                        }
                    }
                }
            } catch (error) {
                this.rejectionStats.errors++;
                logger.error(`[HybridStrategy] Error for city ${city}:`, error);
            }
        }
        
        this.logRejectionStats();
        
        return signals.sort((a, b) => {
            if (a.signalType === 'forecast_change' && b.signalType !== 'forecast_change') return -1;
            if (a.signalType !== 'forecast_change' && b.signalType === 'forecast_change') return 1;
            return Math.abs(b.estimatedEdge) - Math.abs(a.estimatedEdge);
        });
    }
    
    private groupMarketsByCity(markets: ParsedWeatherMarket[]): Map<string, ParsedWeatherMarket[]> {
        const grouped = new Map<string, ParsedWeatherMarket[]>();
        
        for (const market of markets) {
            const city = market.city || 'unknown';
            const list = grouped.get(city) || [];
            list.push(market);
            grouped.set(city, list);
        }
        
        return grouped;
    }
    
    private detectForecastChangeForCity(city: string, cityMarkets: ParsedWeatherMarket[]): HybridSignal[] {
        const signals: HybridSignal[] = [];
        
        const firstMarket = cityMarkets[0];
        if (!firstMarket) return signals;
        
        const state = this.store.getMarketState(firstMarket.market.id);
        if (!state?.lastForecast) return signals;
        
        const forecast = state.lastForecast;
        
        if (!forecast.valueChanged || forecast.previousValue === undefined) {
            return signals;
        }
        
        const changeAge = Date.now() - forecast.changeTimestamp.getTime();
        if (changeAge > 300000) return signals;
        
        const previousValue = forecast.previousValue;
        const currentValue = forecast.forecastValue;
        const changeAmount = Math.abs(currentValue - previousValue);
        
        if (changeAmount < 0.5) return signals;
        
        const direction = currentValue > previousValue ? 'warmer' : 'colder';
        
        logger.info(`[HybridStrategy] FORECAST CHANGE for ${city}: ${previousValue.toFixed(1)}°F → ${currentValue.toFixed(1)}°F (${direction}), checking ${cityMarkets.length} markets`);
        
        for (const market of cityMarkets) {
            if (!market.market.active || market.market.closed) {
                continue;
            }
            
            // Skip closed markets with exact 0.01 or 0.99 prices
            if (market.yesPrice === 0.01 || market.yesPrice === 0.99) {
                continue;
            }
            
            if (market.targetDate) {
                const targetDate = new Date(market.targetDate);
                const today = new Date();
                today.setUTCHours(0, 0, 0, 0);
                targetDate.setUTCHours(0, 0, 0, 0);
                if (targetDate < today) {
                    continue;
                }
            }
            
            if (!market.threshold) continue;
            
            let thresholdF = market.threshold;
            if (market.thresholdUnit === 'C') {
                thresholdF = (thresholdF * 9 / 5) + 32;
            }
            
            const minThresholdF = market.thresholdUnit === 'C' && market.minThreshold
                ? (market.minThreshold * 9 / 5) + 32 
                : (market.minThreshold ?? 0);
            const maxThresholdF = market.thresholdUnit === 'C' && market.maxThreshold
                ? (market.maxThreshold * 9 / 5) + 32 
                : (market.maxThreshold ?? 0);
            
            const priceHistory = state.priceHistory.yes.history;
            if (priceHistory.length === 0) continue;
            const priceYes = priceHistory[priceHistory.length - 1].price;
            
            const daysToEvent = market.targetDate
                ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                : 3;
            const uncertainty = 1.5 + 0.8 * daysToEvent;
            
            let forecastProb: number;
            if (market.comparisonType === 'above') {
                forecastProb = normalCDF((currentValue - thresholdF) / uncertainty);
            } else if (market.comparisonType === 'below') {
                forecastProb = 1 - normalCDF((currentValue - thresholdF) / uncertainty);
            } else if (market.comparisonType === 'range') {
                const probAboveMin = normalCDF((currentValue - minThresholdF) / uncertainty);
                const probAboveMax = normalCDF((currentValue - maxThresholdF) / uncertainty);
                forecastProb = probAboveMin - probAboveMax;
            } else {
                forecastProb = 1 - normalCDF((currentValue - thresholdF) / uncertainty);
            }
            
            const edge = forecastProb - priceYes;
            const absEdge = Math.abs(edge);
            
            let shouldTrade = false;
            let tradeReason = '';
            
            if (direction === 'warmer') {
                if (market.comparisonType === 'above') {
                    if (currentValue > thresholdF) {
                        shouldTrade = true;
                        tradeReason = `Warmer forecast (${currentValue.toFixed(1)}°F) is ABOVE ${thresholdF.toFixed(1)}°F - buy YES`;
                    }
                } else if (market.comparisonType === 'below') {
                    if (currentValue > thresholdF) {
                        shouldTrade = true;
                        tradeReason = `Warmer forecast (${currentValue.toFixed(1)}°F) is ABOVE ${thresholdF.toFixed(1)}°F - buy NO for "below"`;
                    }
                } else if (market.comparisonType === 'range') {
                    const inRange = currentValue >= minThresholdF && currentValue <= maxThresholdF;
                    const wasBelowRange = previousValue < minThresholdF;
                    const wasAboveRange = previousValue > maxThresholdF;
                    
                    if (inRange) {
                        shouldTrade = true;
                        tradeReason = `Warmer forecast (${currentValue.toFixed(1)}°F) is IN RANGE [${minThresholdF.toFixed(1)}, ${maxThresholdF.toFixed(1)}] - buy YES`;
                    } else if (wasBelowRange && currentValue >= minThresholdF) {
                        shouldTrade = true;
                        tradeReason = `Warmer forecast crossed INTO range [${minThresholdF.toFixed(1)}, ${maxThresholdF.toFixed(1)}] - buy YES`;
                    } else if (wasAboveRange && currentValue > maxThresholdF) {
                        shouldTrade = true;
                        tradeReason = `Warmer forecast (${currentValue.toFixed(1)}°F) moved ABOVE range - buy NO`;
                    }
                }
            } else {
                if (market.comparisonType === 'above') {
                    if (currentValue < thresholdF) {
                        shouldTrade = true;
                        tradeReason = `Colder forecast (${currentValue.toFixed(1)}°F) is BELOW ${thresholdF.toFixed(1)}°F - buy NO for "above"`;
                    }
                } else if (market.comparisonType === 'below') {
                    if (currentValue < thresholdF) {
                        shouldTrade = true;
                        tradeReason = `Colder forecast (${currentValue.toFixed(1)}°F) is BELOW ${thresholdF.toFixed(1)}°F - buy YES for "below"`;
                    }
                } else if (market.comparisonType === 'range') {
                    const inRange = currentValue >= minThresholdF && currentValue <= maxThresholdF;
                    const wasBelowRange = previousValue < minThresholdF;
                    const wasAboveRange = previousValue > maxThresholdF;
                    
                    if (inRange) {
                        shouldTrade = true;
                        tradeReason = `Colder forecast (${currentValue.toFixed(1)}°F) is IN RANGE [${minThresholdF.toFixed(1)}, ${maxThresholdF.toFixed(1)}] - buy YES`;
                    } else if (wasAboveRange && currentValue <= maxThresholdF) {
                        shouldTrade = true;
                        tradeReason = `Colder forecast crossed INTO range [${minThresholdF.toFixed(1)}, ${maxThresholdF.toFixed(1)}] - buy YES`;
                    } else if (wasBelowRange && currentValue < minThresholdF) {
                        shouldTrade = true;
                        tradeReason = `Colder forecast (${currentValue.toFixed(1)}°F) moved BELOW range - buy NO`;
                    }
                }
            }
            
            if (!shouldTrade) continue;
            
            const side = edge > 0 ? 'yes' : 'no';
            
            let positionSize = config.maxPositionSize * 1.5;
            
            if (priceYes > 0.1 && priceYes < 0.9) {
                positionSize *= 1.3;
            }
            if (priceYes > 0.2 && priceYes < 0.8) {
                positionSize *= 1.2;
            }
            if (priceYes > 0.3 && priceYes < 0.7) {
                positionSize *= 1.2;
            }
            
            const urgencyMult = changeAge < 30000 ? 1.5 : changeAge < 60000 ? 1.3 : 1.1;
            positionSize *= urgencyMult;
            
            let sigma: number;
            if (market.comparisonType === 'range') {
                if (currentValue >= minThresholdF && currentValue <= maxThresholdF) {
                    sigma = Math.min(currentValue - minThresholdF, maxThresholdF - currentValue) / uncertainty;
                } else if (currentValue < minThresholdF) {
                    sigma = (minThresholdF - currentValue) / uncertainty;
                } else {
                    sigma = (currentValue - maxThresholdF) / uncertainty;
                }
            } else {
                sigma = Math.abs(currentValue - thresholdF) / uncertainty;
            }
            
            if (sigma >= 2.0) positionSize *= 1.5;
            else if (sigma >= 1.5) positionSize *= 1.3;
            else if (sigma >= 1.0) positionSize *= 1.2;
            
            logger.info(`[HybridStrategy]   → ${market.market.question.substring(0, 50)}: ${side.toUpperCase()} @ ${(priceYes * 100).toFixed(1)}%, edge=${(absEdge * 100).toFixed(1)}% | ${tradeReason}`);
            
            signals.push({
                marketId: market.market.id,
                side,
                size: parseFloat(positionSize.toFixed(2)),
                orderType: 'MARKET',
                urgency: 'HIGH',
                estimatedEdge: edge,
                confidence: 0.9,
                reason: tradeReason,
                isGuaranteed: sigma >= 3.0,
                sigma,
                signalType: 'forecast_change',
            });
        }
        
        return signals;
    }
    
    private detectHighConfidenceSignal(market: ParsedWeatherMarket): HybridSignal | null {
        const marketId = market.market.id;
        const city = market.city;
        
        if (!market.market.active || market.market.closed) {
            return null;
        }
        
        // Skip closed markets with exact 0.01 or 0.99 prices
        if (market.yesPrice === 0.01 || market.yesPrice === 0.99) {
            return null;
        }
        
        if (market.targetDate) {
            const targetDate = new Date(market.targetDate);
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            targetDate.setUTCHours(0, 0, 0, 0);
            if (targetDate < today) {
                return null;
            }
        }
        
        this.rejectionStats.totalChecked++;
        
        try {
            const state = this.store.getMarketState(marketId);
            if (!state?.lastForecast) {
                this.rejectionStats.noForecast++;
                return null;
            }
            
            const forecast = state.lastForecast;
            
            if (forecast.valueChanged) {
                const changeAge = Date.now() - forecast.changeTimestamp.getTime();
                if (changeAge < 300000) return null;
            }
            
            const priceHistory = state.priceHistory.yes.history;
            if (priceHistory.length === 0) {
                this.rejectionStats.noPriceHistory++;
                return null;
            }
            const priceYes = priceHistory[priceHistory.length - 1].price;
            
            let threshold = market.threshold;
            if (threshold === undefined) {
                this.rejectionStats.noThreshold++;
                return null;
            }
            if (market.thresholdUnit === 'C') {
                threshold = (threshold * 9 / 5) + 32;
            }
            
            const minThresholdF = market.thresholdUnit === 'C' && market.minThreshold
                ? (market.minThreshold * 9 / 5) + 32 
                : (market.minThreshold ?? 0);
            const maxThresholdF = market.thresholdUnit === 'C' && market.maxThreshold
                ? (market.maxThreshold * 9 / 5) + 32 
                : (market.maxThreshold ?? 0);
            
            const daysToEvent = market.targetDate
                ? Math.max(0, (new Date(market.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                : 3;
            const uncertainty = 1.5 + 0.8 * daysToEvent;
            
            let sigma: number;
            if (market.comparisonType === 'range') {
                if (forecast.forecastValue >= minThresholdF && forecast.forecastValue <= maxThresholdF) {
                    sigma = Math.min(forecast.forecastValue - minThresholdF, maxThresholdF - forecast.forecastValue) / uncertainty;
                } else if (forecast.forecastValue < minThresholdF) {
                    sigma = (minThresholdF - forecast.forecastValue) / uncertainty;
                } else {
                    sigma = (forecast.forecastValue - maxThresholdF) / uncertainty;
                }
            } else {
                sigma = Math.abs(forecast.forecastValue - threshold) / uncertainty;
            }
            
            let forecastProb: number;
            if (market.comparisonType === 'above') {
                forecastProb = normalCDF((forecast.forecastValue - threshold) / uncertainty);
            } else if (market.comparisonType === 'below') {
                forecastProb = 1 - normalCDF((forecast.forecastValue - threshold) / uncertainty);
            } else if (market.comparisonType === 'range') {
                const probAboveMin = normalCDF((forecast.forecastValue - minThresholdF) / uncertainty);
                const probAboveMax = normalCDF((forecast.forecastValue - maxThresholdF) / uncertainty);
                forecastProb = probAboveMin - probAboveMax;
            } else {
                forecastProb = 1 - normalCDF((forecast.forecastValue - threshold) / uncertainty);
            }
            
            const edge = forecastProb - priceYes;
            const confidence = this.calculateConfidence(sigma, daysToEvent, forecast);
            
            if (confidence < this.MIN_CONFIDENCE_THRESHOLD) {
                return null;
            }
            
            const kellyFraction = this.calculateKellyFraction(confidence, sigma);
            let positionSize = config.maxPositionSize * kellyFraction * 1.5;
            
            if (priceYes > 0.1 && priceYes < 0.9) {
                positionSize *= 1.3;
            }
            if (priceYes > 0.2 && priceYes < 0.8) {
                positionSize *= 1.2;
            }
            if (priceYes > 0.3 && priceYes < 0.7) {
                positionSize *= 1.2;
            }
            
            if (sigma >= 2.0) positionSize *= 1.5;
            else if (sigma >= 1.5) positionSize *= 1.3;
            else if (sigma >= 1.0) positionSize *= 1.2;
            
            const side = edge > 0 ? 'yes' : 'no';
            
            logger.info(`[HybridStrategy] HIGH CONFIDENCE signal for ${city} (${marketId}): confidence=${(confidence * 100).toFixed(0)}%, edge=${(Math.abs(edge) * 100).toFixed(1)}%`);
            
            return {
                marketId,
                side,
                size: parseFloat(positionSize.toFixed(2)),
                orderType: 'MARKET',
                urgency: 'MEDIUM',
                estimatedEdge: edge,
                confidence,
                reason: `High confidence (${(confidence * 100).toFixed(0)}%)`,
                isGuaranteed: sigma >= 3.0,
                sigma,
                signalType: 'high_confidence',
            };
        } catch (error) {
            this.rejectionStats.errors++;
            logger.error(`[HybridStrategy] Error in detectHighConfidenceSignal for ${city} (${marketId}):`, error);
            return null;
        }
    }
    
    private calculateConfidence(sigma: number, daysToEvent: number, forecast: any): number {
        let confidence = 0.5;
        
        confidence += Math.min(0.30, sigma * 0.10);
        
        if (daysToEvent > 3) {
            confidence -= (daysToEvent - 3) * 0.03;
        }
        
        if (forecast?.weatherData?.source === 'FILE') {
            confidence += 0.10;
        }
        
        return Math.max(0, Math.min(1.0, confidence));
    }
    
    private calculateKellyFraction(confidence: number, sigma: number): number {
        if (sigma >= 3.0) return config.KELLY_FRACTION_GUARANTEED;
        if (sigma >= 2.0) return config.KELLY_FRACTION_HIGH;
        if (sigma >= 1.0) return config.KELLY_FRACTION_MEDIUM;
        return config.KELLY_FRACTION_LOW;
    }
    
    markOpportunityCaptured(marketId: string, forecastValue: number, signalType: 'high_confidence' | 'forecast_change'): void {
    }
    
    getRejectionStats(): HybridRejectionStats {
        return { ...this.rejectionStats };
    }
    
    resetRejectionStats(): void {
        this.rejectionStats = {
            totalChecked: 0,
            noMarketState: 0,
            noForecast: 0,
            noThreshold: 0,
            noPriceHistory: 0,
            errors: 0,
        };
    }
    
    private logRejectionStats(): void {
        const now = Date.now();
        const hasRejections = this.rejectionStats.totalChecked > 0;
        if (hasRejections && now - this.lastRejectionLogTime > 15 * 60 * 1000) {
            logger.info('[HybridStrategy] Rejection Stats (last 15 min)', {
                totalChecked: this.rejectionStats.totalChecked,
                noForecast: this.rejectionStats.noForecast,
                noThreshold: this.rejectionStats.noThreshold,
                noPriceHistory: this.rejectionStats.noPriceHistory,
                errors: this.rejectionStats.errors,
            });
            this.resetRejectionStats();
            this.lastRejectionLogTime = now;
        }
    }
}

export default HybridTradingStrategy;
