/**
 * Polymarket types for weather bot
 */

export interface PolymarketMarket {
    id: string;
    conditionId: string;
    slug: string;
    question: string;
    description?: string;
    outcomes: string[];
    outcomePrices: string[];
    clobTokenIds: string[];
    active: boolean;
    closed: boolean;
    endDateIso?: string;
    volume?: string;
    liquidity?: string;
    tags?: Array<{ id: string; label: string; slug: string }>;
}

export interface PolymarketEvent {
    id: string;
    slug: string;
    title: string;
    description?: string;
    active: boolean;
    closed: boolean;
    markets: PolymarketMarket[];
    tags?: Array<{ id: string; label: string; slug: string }>;
    startDate?: string;
    endDate?: string;
}

export interface MarketPrice {
    tokenId: string;
    outcome: string;
    price: number; // 0-1
    side: 'yes' | 'no';
}

export interface OrderBookEntry {
    price: string;
    size: string;
}

export interface OrderBook {
    market: string;
    assetId: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
}

/**
 * Parsed weather market with extracted information
 */
export interface ParsedWeatherMarket {
    market: PolymarketMarket;
    eventTitle: string;

    // Extracted info from question
    city: string | null;
    metricType: 'temperature_high' | 'temperature_low' | 'temperature_threshold' | 'temperature_range' | 'precipitation' | 'unknown';
    threshold?: number;
    minThreshold?: number;
    maxThreshold?: number;
    thresholdUnit?: 'F' | 'C' | 'inches';
    comparisonType?: 'above' | 'below' | 'equals' | 'range';
    targetDate?: Date;

    // Current market state
    yesPrice: number;
    noPrice: number;
    yesTokenId: string;
    noTokenId: string;
}

/**
 * Trading opportunity identified by the bot
 */
export interface TradingOpportunity {
    market: ParsedWeatherMarket;

    // Our calculated probability based on weather data
    forecastProbability: number;

    // Market implied probability
    marketProbability: number;

    // Edge = forecast - market (positive = underpriced YES)
    edge: number;

    // Suggested action
    action: 'buy_yes' | 'buy_no' | 'none';

    // Confidence in our forecast (0-1)
    confidence: number;

    // Reasoning for the opportunity
    reason: string;

    // Weather data used
    weatherDataSource: 'noaa' | 'openweather';
    forecastValue?: number;
    forecastValueUnit?: string;

    // Guaranteed outcome detection
    isGuaranteed: boolean;      // Whether this is a near-certain outcome
    certaintySigma?: number;    // How many std devs from threshold
}

/**
 * Order to be placed
 */
export interface TradeOrder {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number; // Number of shares
    orderType: 'GTC' | 'FOK' | 'GTD';
}

/**
 * Position held by the bot
 */
export interface Position {
    tokenId: string;
    marketId: string;
    marketQuestion: string;
    side: 'yes' | 'no';
    size: number;
    avgPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
    entryTime: Date;
}
