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
    'rain', 'rainfall', 'precipitation',
    'weather', 'forecast',
    'high of', 'low of', 'highest', 'lowest',
    'hurricane', 'storm', 'tornado',
    'freeze', 'freezing', 'frost',
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

        // Extract metric type and threshold - use QUESTION only to avoid Date matching in Title
        // Pass city to help infer units (e.g. Buenos Aires -> C, New York -> F)
        const { metricType, threshold, minThreshold, maxThreshold, thresholdUnit, comparisonType } = this.extractMetric(question, city);

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
            minThreshold,
            maxThreshold,
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
     * Extract city name from market text using findCity from types.js
     */
    private extractCity(text: string): string | null {
        const words = text.toLowerCase().split(/\s+/);
        for (const word of words) {
            const cityLocation = findCity(word);
            if (cityLocation) {
                return cityLocation.name;
            }
        }
        for (let i = 0; i < words.length - 1; i++) {
            const twoWord = `${words[i]} ${words[i + 1]}`;
            const cityLocation = findCity(twoWord);
            if (cityLocation) {
                return cityLocation.name;
            }
        }
        for (let i = 0; i < words.length - 2; i++) {
            const threeWord = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
            const cityLocation = findCity(threeWord);
            if (cityLocation) {
                return cityLocation.name;
            }
        }
        return null;
    }

    /**
     * Extract weather metric type and threshold
     */
    private extractMetric(text: string, city: string | null): {
        metricType: ParsedWeatherMarket['metricType'];
        threshold?: number;
        minThreshold?: number;
        maxThreshold?: number;
        thresholdUnit?: 'F' | 'C' | 'inches';
        comparisonType?: 'above' | 'below' | 'equals' | 'range';
    } {
        // Don't reject snow markets outright - check for temperature thresholds first
        // Only mark as unknown if it's purely a snowfall amount market with no temperature
        if (text.match(/snow|blizzard/i)) {
            // Continue to check for temperature thresholds before rejecting
            // Temperature markets with snow context should still be parsed
        }

        // Determine default unit based on city location
        let defaultUnit: 'F' | 'C' = 'F';
        if (city) {
            const location = findCity(city);
            if (location && location.country !== 'US') {
                defaultUnit = 'C';
            }
        }

        // Temperature range patterns: "Between 30 and 40", "30-40 degrees"
        // MUST NOT contain precipitation/snow keywords to avoid false positives
        if (!text.match(/precipitation|rain|inches|"/i)) {
            const rangeMatch = text.match(/between\s*(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?\s*(?:and|to|-)\s*(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
            if (rangeMatch) {
                const val1 = parseInt(rangeMatch[1], 10);
                const val2 = parseInt(rangeMatch[3], 10);

                // Determine unit (check both spots)
                const unit = (rangeMatch[2] || rangeMatch[4] || defaultUnit).toUpperCase() as 'F' | 'C';
                
                return {
                    metricType: 'temperature_range',
                    minThreshold: Math.min(val1, val2),
                    maxThreshold: Math.max(val1, val2),
                    thresholdUnit: unit,
                    comparisonType: 'range',
                };
            }
        }

        // Temperature high patterns
        // Matches: 7°C, 7 C, 7 degrees C, 7 deg C, 7°
        const highTempMatch = text.match(/(?:highest|high|maximum|max)\s*(?:temp|temperature)?[^\d]*?(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        if (highTempMatch) {
            // Check direction explicitly
            const isBelow = text.match(/\b(below|under|less|lower|fewer)\b/i);
            const isAbove = text.match(/\b(above|exceeds?|over|higher|greater|more|at least)\b/i);

            const val = parseInt(highTempMatch[1], 10);
            const unit = (highTempMatch[2]?.toUpperCase() as 'F' | 'C') || defaultUnit;

            if (!isBelow && !isAbove) {
                // No direction specified -> Treat as exact bucket (e.g., "32" means 32 <= T < 33)
                // We use temperature_range [val, val + 1]
                return {
                    metricType: 'temperature_range',
                    minThreshold: val,
                    maxThreshold: val + 1,
                    thresholdUnit: unit,
                    comparisonType: 'range',
                };
            }

            // Default to 'above' (>=) if no direction specified (legacy behavior if fallthrough? No, handled above)
            // Actually, if isAbove is true OR neither but some other context?
            // "at least" matches isAbove.
            const comparisonType = isBelow ? 'below' : 'above';

            return {
                metricType: 'temperature_high',
                threshold: val,
                thresholdUnit: unit,
                comparisonType,
            };
        }

        // Temperature threshold patterns (e.g. "90°F or higher", "be 64°F or higher", "at least 64°F", "reach 64°F")
        // Matches various phrasings: "64°F or higher", "64°F or more", "be 64°F or higher", "at least 64°F", "reach 64°F"
        const tempThresholdMatch = text.match(/(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?\s*(?:(?:be\s+)?(?:or\s+)?(?:at\s*least|from|above|higher|more|over|greater|reach)\b|\b(?:at\s*least)\s+\d+)/i);
        
        // Try more specific patterns if the general one doesn't match
        let aboveMatch = tempThresholdMatch;
        if (!aboveMatch) {
            // Pattern for "at least 64°F" (number comes after "at least")
            aboveMatch = text.match(/(?:at\s*least|minimum)\s*(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        }
        if (!aboveMatch) {
            // Pattern for "will reach 64°F" (number comes after "reach")
            aboveMatch = text.match(/(?:reach|exceed)\s*(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        }
        if (aboveMatch) {
            // Check if there's explicit "above" context in the text
            const hasAboveContext = text.match(/\b(above|higher|more|over|greater|at least|minimum|reach|exceed)\b/i);
            // Only treat as 'above' if we have explicit above context or if pattern matched above keywords
            if (hasAboveContext || tempThresholdMatch) {
                return {
                    metricType: 'temperature_threshold',
                    threshold: parseInt(aboveMatch[1], 10),
                    thresholdUnit: (aboveMatch[2]?.toUpperCase() as 'F' | 'C') || defaultUnit,
                    comparisonType: 'above',
                };
            }
        }

        // Temperature below patterns (e.g. "64°F or below", "under 64°F", "less than 64°F")
        const tempBelowMatch = text.match(/(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?\s*(?:(?:be\s+)?(?:or\s+)?(?:below|under|less|lower)\b|\b(?:below|under|less)\s+than\s+\d+)/i);
        
        // Try more specific patterns if the general one doesn't match
        let belowMatch = tempBelowMatch;
        if (!belowMatch) {
            // Pattern for "below 64°F", "under 64°F", "less than 64°F"
            belowMatch = text.match(/\b(below|under|less\s*than)\s+(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        }
        if (!belowMatch) {
            // Pattern for "at most 64°F" (number comes after "at most")
            belowMatch = text.match(/(?:at\s*most|maximum)\s*(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        }
        if (belowMatch) {
            // Determine which capture group has the threshold value
            // For patterns like "64°F or below": belowMatch[1] = threshold, belowMatch[2] = unit
            // For patterns like "below 64°F": belowMatch[1] = 'below', belowMatch[2] = threshold, belowMatch[3] = unit
            let thresholdVal: number;
            let thresholdUnit: 'F' | 'C';
            
            if (belowMatch[2] && /^\d+$/.test(belowMatch[2])) {
                // Pattern with 3 groups: number is in group 2
                thresholdVal = parseInt(belowMatch[2], 10);
                thresholdUnit = belowMatch[3] ? (belowMatch[3].toUpperCase() as 'F' | 'C') : defaultUnit;
            } else {
                // Pattern with 2 groups: number is in group 1
                thresholdVal = parseInt(belowMatch[1], 10);
                thresholdUnit = belowMatch[2] ? (belowMatch[2].toUpperCase() as 'F' | 'C') : defaultUnit;
            }
            
            return {
                metricType: 'temperature_threshold',
                threshold: thresholdVal,
                thresholdUnit,
                comparisonType: 'below',
            };
        }

        // Just a temperature number (ambiguous context)
        const simpleTempMatch = text.match(/(?:temperature|temp)[^\d]*?(-?\d+)\s*(?:°|degrees?|deg)?\s*([fc])?/i);
        if (simpleTempMatch) {
            const val = parseInt(simpleTempMatch[1], 10);
            const unit = (simpleTempMatch[2]?.toUpperCase() as 'F' | 'C') || defaultUnit;
            
            // Check direction again just in case simple match missed context
            const isBelow = text.match(/\b(below|under|less|lower|fewer)\b/i);
            const isAbove = text.match(/\b(above|exceeds?|over|higher|greater|more|at least)\b/i);

            if (!isBelow && !isAbove) {
                return {
                    metricType: 'temperature_range',
                    minThreshold: val,
                    maxThreshold: val + 1,
                    thresholdUnit: unit,
                    comparisonType: 'range',
                };
            }

            return {
                metricType: 'temperature_high',
                threshold: val,
                thresholdUnit: unit,
                comparisonType: isBelow ? 'below' : 'above',
            };
        }

        // Precipitation
        if (text.includes('rain') || text.includes('precipitation')) {
            // Look for patterns like "more than X inches", "at least X mm", etc.
            const inchesMatch = text.match(/(\d+\.?\d*)\s*(?:inch|in|inches)/i);
            const mmMatch = text.match(/(\d+\.?\d*)\s*(?:mm|millimeter)/i);
            
            if (inchesMatch) {
                return {
                    metricType: 'precipitation',
                    threshold: parseFloat(inchesMatch[1]),
                    thresholdUnit: 'inches',
                    comparisonType: 'above',
                };
            }
            if (mmMatch) {
                return {
                    metricType: 'precipitation',
                    threshold: parseFloat(mmMatch[1]),
                    thresholdUnit: 'inches', // Convert mm to inches for consistency
                    comparisonType: 'above',
                };
            }
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
                // Create date in UTC to avoid timezone issues
                let date = new Date(Date.UTC(year, month, day));
                // S8: Fix year-rollover - if date is >30 days in the past and no year was
                // explicitly specified, assume it refers to next year
                if (!monthDayMatch[3] && date.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
                    date = new Date(Date.UTC(year + 1, month, day));
                }
                return date;
            }
        }

        // "today"
        if (text.includes('today')) {
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            return today;
        }

        // "tomorrow"
        if (text.includes('tomorrow')) {
            const tomorrow = new Date();
            tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
            tomorrow.setUTCHours(0, 0, 0, 0);
            return tomorrow;
        }

        // "this weekend"
        if (text.includes('this weekend') || text.includes('weekend')) {
            const saturday = new Date();
            saturday.setUTCDate(saturday.getUTCDate() + (6 - saturday.getDay()));
            saturday.setUTCHours(0, 0, 0, 0);
            return saturday;
        }

        // Use event end date if available
        if (event.endDate) {
            const date = new Date(event.endDate);
            date.setUTCHours(0, 0, 0, 0);
            return date;
        }

        return undefined;
    }

    /**
     * Filter markets to only actionable ones
     */
    filterActionableMarkets(markets: ParsedWeatherMarket[]): ParsedWeatherMarket[] {
        return markets.filter(m => {
            // Check if market is active and not closed
            if (!m.market.active || m.market.closed) {
                logger.debug(`Rejecting ${m.market.question}: Market inactive or closed`);
                return false;
            }

            // Filter out closed/resolved markets (exact 0.01 or 0.99 prices)
            if (m.yesPrice === 0.01 || m.yesPrice === 0.99 || m.noPrice === 0.01 || m.noPrice === 0.99) {
                logger.debug(`Rejecting ${m.market.question}: Market closed (price 0.01 or 0.99)`);
                return false;
            }

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

            // Must have valid prices
            if (m.yesPrice <= 0 && m.noPrice <= 0) {
                logger.debug(`Rejecting ${m.market.question}: No liquidity (Price 0)`);
                return false;
            }

            // Must have target date within forecast range - NO PAST DATES
            if (m.targetDate) {
                const now = new Date();
                const targetDate = new Date(m.targetDate);
                targetDate.setUTCHours(0, 0, 0, 0);
                const today = new Date(now);
                today.setUTCHours(0, 0, 0, 0);

                const daysUntil = (targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
                if (daysUntil < 0 || daysUntil > 21) {  // CHANGED: No past dates allowed
                    logger.debug(`Rejecting ${m.market.question}: Date out of range (${daysUntil.toFixed(1)} days)`);
                    return false;
                }
            }

            return true;
        });
    }
}
