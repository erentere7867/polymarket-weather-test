/**
 * Real-Time Engine Types
 */

import { ParsedWeatherMarket } from '../polymarket/types.js';
import { WeatherData } from '../weather/types.js';

export interface PricePoint {
    price: number;
    timestamp: Date;
}

export interface PriceHistory {
    tokenId: string;
    history: PricePoint[]; // Ordered by timestamp ASC
    lastUpdated: Date;
    velocity: number; // Price change per second (last 1 min)
}

export interface ForecastSnapshot {
    marketId: string;
    weatherData: WeatherData;
    forecastValue: number; // The specific value relevant to the market (e.g. high temp)
    probability: number; // Calculated probability of YES
    timestamp: Date;

    // Speed arbitrage: track when forecast actually changes
    previousValue?: number;       // What the forecast was before
    valueChanged: boolean;        // Did the value change significantly?
    changeAmount: number;         // How much did it change?
    changeTimestamp: Date;        // When did the value last change?
}

export interface MarketState {
    market: ParsedWeatherMarket;
    priceHistory: {
        yes: PriceHistory;
        no: PriceHistory;
    };
    lastForecast?: ForecastSnapshot;
    forecastHistory: ForecastSnapshot[];
}

export interface TradeSignal {
    id: string;
    type: 'FORECAST_UPDATE' | 'PRICE_LAG' | 'MOMENTUM';
    marketId: string;
    timestamp: Date;
    direction: 'BUY_YES' | 'BUY_NO';
    strength: number; // 0-1 confidence
    reason: string;
    estimatedEdge: number;
}
