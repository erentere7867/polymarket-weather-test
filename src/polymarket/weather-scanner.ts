/**
 * Weather Market Scanner
 * Identifies and parses weather-related markets from Polymarket
 */

import { GammaClient } from './gamma-client.js';
import { PolymarketEvent, PolymarketMarket, ParsedWeatherMarket } from './types.js';
import { findCity } from '../weather/types.js';
import { logger } from '../logger.js';

// Keywords that indicate a weather market
const WEATHER_KEYWORDS = [
    'temperature', 'temp', 'degrees', '°f', '°c',
    'snow', 'snowfall', 'inches of snow',
    'rain', 'rainfall', 'precipitation',
    'weather', 'forecast',
    'high of', 'low of', 'highest', 'lowest',
    'hurricane', 'storm', 'tornado',
    'freeze', 'freezing', 'frost',
];

// Common cities in weather markets
// Order matters: longer/more specific patterns first to avoid partial matches
const CITY_PATTERNS: Array<{ pattern: string; name: string }> = [
    { pattern: 'new york city', name: 'New York City' },
    { pattern: 'new york', name: 'New York City' },
    { pattern: 'nyc', name: 'New York City' },
    { pattern: 'washington dc', name: 'Washington DC' },
    { pattern: 'washington d.c.', name: 'Washington DC' },
    { pattern: 'washington', name: 'Washington DC' },
    { pattern: 'd.c.', name: 'Washington DC' },
    { pattern: 'dc', name: 'Washington DC' },
    { pattern: 'los angeles', name: 'Los Angeles' },
    { pattern: 'buenos aires', name: 'Buenos Aires' },
    { pattern: 'chicago', name: 'Chicago' },
    { pattern: 'dallas', name: 'Dallas' },
    { pattern: 'atlanta', name: 'Atlanta' },
    { pattern: 'seattle', name: 'Seattle' },
    { pattern: 'miami', name: 'Miami' },
    { pattern: 'toronto', name: 'Toronto' },
    { pattern: 'london', name: 'London' },
    { pattern: 'seoul', name: 'Seoul' },
    { pattern: 'ankara', name: 'Ankara' },
];

// Keywords to EXCLUDE from weather markets (not actual weather)
const EXCLUDED_KEYWORDS = [
    'earthquake',
    'seismic',
    'magnitude',
    'richter',
    'tremor',
    'quake',
    'aftershock',
    'tectonic',
];

export class WeatherScanner {
    private gammaClient: GammaClient;

    constructor() {
        this.gammaClient = new GammaClient();
    }

    /**
     * Scan Polymarket for weather-related markets
     */
    async scanForWeatherMarkets(): Promise<ParsedWeatherMarket[]> {
        logger.info('Scanning Polymarket for weather markets...');

        // Fetch weather-specific tags: "Climate & Weather" (1474), "Climate" (87), "Weather" (84)
        const weatherTagId = '1474';
        const climateTagId = '87';
        const simpleWeatherTagId = '84';

        // Run fetches in parallel
        const [tagEvents1, tagEvents2, tagEvents3] = await Promise.all([
            this.gammaClient.getEventsByTag(weatherTagId, 100),
            this.gammaClient.getEventsByTag(climateTagId, 100),
            this.gammaClient.getEventsByTag(simpleWeatherTagId, 100)
        ]);

        // Merge and deduplicate by ID
        const allEventsMap = new Map<string, PolymarketEvent>();
        [...tagEvents1, ...tagEvents2, ...tagEvents3].forEach(e => allEventsMap.set(e.id, e));

        const allEvents = Array.from(allEventsMap.values());
        logger.info(`Fetched ${allEvents.length} unique events from weather tags`);

        const weatherMarkets: ParsedWeatherMarket[] = [];

        for (const event of allEvents) {
            for (const market of event.markets) {
                // We still check isWeatherMarket just in case, but rely less on keywords since tags are specific
                const parsed = this.parseWeatherMarket(market, event);
                if (parsed) {
                    weatherMarkets.push(parsed);
                }
            }
        }

        const validMarkets = this.filterActionableMarkets(weatherMarkets);
        logger.info(`Found ${validMarkets.length} valid weather markets (from ${weatherMarkets.length} candidates)`);
        return validMarkets;
    }

    /**
     * Check if a market is weather-related
     */
    private isWeatherMarket(market: PolymarketMarket, event: PolymarketEvent): boolean {
        const text = `${event.title} ${market.question} ${market.description || ''}`.toLowerCase();

        return WEATHER_KEYWORDS.some(keyword => text.includes(keyword));
    }

    /**
     * Parse a weather market to extract structured information
     */
    parseWeatherMarket(market: PolymarketMarket, event: PolymarketEvent): ParsedWeatherMarket | null {
        const question = market.question.toLowerCase();
        const eventTitle = event.title.toLowerCase();
        const fullText = `${eventTitle} ${question}`;

        // Extract city
        const city = this.extractCity(fullText);

        // Extract metric type and threshold
        // Try question first (more accurate), fallback to full text
        let metric = this.extractMetric(question);
        if (metric.metricType === 'unknown') {
            metric = this.extractMetric(fullText);
        }
        const { metricType, threshold, thresholdUnit, comparisonType } = metric;

        // Extract target date
        const targetDate = this.extractDate(fullText, event);

        // Get current prices
        const yesPrice = parseFloat(market.outcomePrices[0] || '0');
        const noPrice = parseFloat(market.outcomePrices[1] || '0');

        if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
            logger.debug(`Skipping market without token IDs: ${market.question}`);
            return null;
        }

        return {
            market,
            eventTitle: event.title,
            city,
            metricType,
            threshold,
            thresholdUnit,
            comparisonType,
            targetDate,
            yesPrice,
            noPrice,
            yesTokenId: market.clobTokenIds[0],
            noTokenId: market.clobTokenIds[1],
        };
    }

    /**
     * Extract city name from market text using word boundary matching
     */
    private extractCity(text: string): string | null {
        const lowerText = text.toLowerCase();

        for (const { pattern, name } of CITY_PATTERNS) {
            // Use word boundary check to avoid partial matches
            // e.g., 'la' should not match 'dallas' or 'atlanta'
            const regex = new RegExp(`\\b${pattern.replace(/\./g, '\\.')}\\b`, 'i');
            if (regex.test(lowerText)) {
                return name;
            }
        }
        return null;
    }

    /**
     * Extract weather metric type and threshold
     */
    private extractMetric(text: string): {
        metricType: ParsedWeatherMarket['metricType'];
        threshold?: number;
        thresholdUnit?: 'F' | 'C' | 'inches';
        comparisonType?: 'above' | 'below' | 'equals' | 'range';
    } {
        // Temperature high patterns
        const highTempMatch = text.match(/(?:highest|high|maximum|max)\s*(?:temp|temperature)?[^\d]*?(\d+)\s*°?([fc])?/i);
        if (highTempMatch) {
            return {
                metricType: 'temperature_high',
                threshold: parseInt(highTempMatch[1], 10),
                thresholdUnit: (highTempMatch[2]?.toUpperCase() as 'F' | 'C') || 'F',
                comparisonType: text.includes('above') || text.includes('exceed') || text.includes('over') ? 'above' : 'below',
            };
        }

        // Temperature threshold patterns
        const tempThresholdMatch = text.match(/(\d+)\s*°?([fc])?\s*(?:or\s*)?(?:above|higher|more|over)/i);
        if (tempThresholdMatch) {
            return {
                metricType: 'temperature_threshold',
                threshold: parseInt(tempThresholdMatch[1], 10),
                thresholdUnit: (tempThresholdMatch[2]?.toUpperCase() as 'F' | 'C') || 'F',
                comparisonType: 'above',
            };
        }

        // Temperature below patterns
        const tempBelowMatch = text.match(/(\d+)\s*°?([fc])?\s*(?:or\s*)?(?:below|under|less)/i);
        if (tempBelowMatch) {
            return {
                metricType: 'temperature_threshold',
                threshold: parseInt(tempBelowMatch[1], 10),
                thresholdUnit: (tempBelowMatch[2]?.toUpperCase() as 'F' | 'C') || 'F',
                comparisonType: 'below',
            };
        }

        // Just a temperature number
        const simpleTempMatch = text.match(/(?:temperature|temp)[^\d]*?(\d+)\s*°?([fc])?/i);
        if (simpleTempMatch) {
            return {
                metricType: 'temperature_high',
                threshold: parseInt(simpleTempMatch[1], 10),
                thresholdUnit: (simpleTempMatch[2]?.toUpperCase() as 'F' | 'C') || 'F',
                comparisonType: 'above',
            };
        }

        // Snowfall patterns
        const snowMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:inches?|in|")?\s*(?:of\s*)?snow/i);
        if (snowMatch) {
            return {
                metricType: 'snowfall',
                threshold: parseFloat(snowMatch[1]),
                thresholdUnit: 'inches',
                comparisonType: text.includes('less') || text.includes('under') ? 'below' : 'above',
            };
        }

        // Snow yes/no (will it snow)
        if (text.includes('snow') && !snowMatch) {
            return {
                metricType: 'snowfall',
                threshold: 0.1, // Any snow
                thresholdUnit: 'inches',
                comparisonType: 'above',
            };
        }

        // Precipitation
        if (text.includes('rain') || text.includes('precipitation')) {
            return {
                metricType: 'precipitation',
                comparisonType: 'above',
            };
        }

        return { metricType: 'unknown' };
    }

    /**
     * Extract target date from market text
     */
    private extractDate(text: string, event: PolymarketEvent): Date | undefined {
        const now = new Date();

        // Look for specific date mentions
        // "January 24" or "Jan 24"
        const monthDayMatch = text.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i);
        if (monthDayMatch) {
            const monthStr = monthDayMatch[1].toLowerCase();
            const day = parseInt(monthDayMatch[2], 10);
            const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : now.getFullYear();

            const monthMap: { [key: string]: number } = {
                'january': 0, 'jan': 0,
                'february': 1, 'feb': 1,
                'march': 2, 'mar': 2,
                'april': 3, 'apr': 3,
                'may': 4,
                'june': 5, 'jun': 5,
                'july': 6, 'jul': 6,
                'august': 7, 'aug': 7,
                'september': 8, 'sep': 8,
                'october': 9, 'oct': 9,
                'november': 10, 'nov': 10,
                'december': 11, 'dec': 11,
            };

            const month = monthMap[monthStr];
            if (month !== undefined) {
                return new Date(year, month, day);
            }
        }

        // "today"
        if (text.includes('today')) {
            return now;
        }

        // "tomorrow"
        if (text.includes('tomorrow')) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            return tomorrow;
        }

        // "this weekend"
        if (text.includes('this weekend') || text.includes('weekend')) {
            const saturday = new Date(now);
            saturday.setDate(saturday.getDate() + (6 - saturday.getDay()));
            return saturday;
        }

        // Use event end date if available
        if (event.endDate) {
            return new Date(event.endDate);
        }

        return undefined;
    }

    /**
     * Filter markets to only actionable ones
     */
    filterActionableMarkets(markets: ParsedWeatherMarket[]): ParsedWeatherMarket[] {
        return markets.filter(m => {
            const fullText = `${m.eventTitle} ${m.market.question}`.toLowerCase();

            // Exclude earthquake/seismic markets - not actual weather
            if (EXCLUDED_KEYWORDS.some(keyword => fullText.includes(keyword))) {
                logger.debug(`Rejecting ${m.market.question}: Contains excluded keyword (earthquake/seismic)`);
                return false;
            }

            // Must have a known city
            if (!m.city) {
                logger.debug(`Rejecting ${m.market.question}: No city found`);
                return false;
            }

            // Must be a supported metric type
            if (m.metricType === 'unknown') {
                logger.debug(`Rejecting ${m.market.question}: Unknown metric`);
                return false;
            }

            // Reject Range markets ("Between X and Y") as they are not supported yet
            // and often misclassified as "Below" markets
            if (m.market.question.toLowerCase().includes('between')) {
                logger.debug(`Rejecting ${m.market.question}: Range markets not supported`);
                return false;
            }

            // Must have valid prices
            if (m.yesPrice <= 0 && m.noPrice <= 0) {
                logger.debug(`Rejecting ${m.market.question}: No liquidity (Price 0)`);
                return false;
            }

            // Must have target date within forecast range (7 days)
            if (m.targetDate) {
                const now = new Date();
                const daysUntil = (m.targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
                if (daysUntil < -2 || daysUntil > 14) { // Relaxed window: -2 to +14 days
                    logger.debug(`Rejecting ${m.market.question}: Date out of range (${daysUntil.toFixed(1)} days)`);
                    return false;
                }
            }

            return true;
        });
    }
}
