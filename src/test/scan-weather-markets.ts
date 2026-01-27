/**
 * Test script: Scan Polymarket for weather markets
 * Run with: npx ts-node --esm src/test/scan-weather-markets.ts
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
    logger.info('Scanning Polymarket for weather markets...');

    const scanner = new WeatherScanner();

    try {
        const allMarkets = await scanner.scanForWeatherMarkets();

        logger.info(`Found ${allMarkets.length} total weather markets`);

        for (const market of allMarkets) {
            console.log('\n' + '='.repeat(60));
            console.log(`Question: ${market.market.question}`);
            console.log(`Event: ${market.eventTitle}`);
            console.log(`City: ${market.city || 'Unknown'}`);
            console.log(`Metric: ${market.metricType}`);
            console.log(`Threshold: ${market.threshold || 'N/A'} ${market.thresholdUnit || ''}`);
            console.log(`Comparison: ${market.comparisonType || 'N/A'}`);
            console.log(`Target Date: ${market.targetDate?.toISOString() || 'N/A'}`);
            console.log(`YES Price: ${(market.yesPrice * 100).toFixed(1)}%`);
            console.log(`NO Price: ${(market.noPrice * 100).toFixed(1)}%`);
            console.log(`Outcomes: ${JSON.stringify(market.market.outcomes)}`);
            console.log(`YES Token: ${market.yesTokenId.substring(0, 20)}...`);
        }

        // Filter actionable
        const actionable = scanner.filterActionableMarkets(allMarkets);
        console.log('\n' + '='.repeat(60));
        console.log(`Actionable markets: ${actionable.length}/${allMarkets.length}`);

        for (const market of actionable) {
            console.log(`  - ${market.city}: ${market.metricType} (${market.market.question.substring(0, 40)}...)`);
        }

    } catch (error) {
        logger.error('Scan failed', { error: (error as Error).message });
        process.exit(1);
    }
}

main().catch(console.error);
