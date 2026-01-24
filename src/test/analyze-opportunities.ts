/**
 * Test script: Full opportunity analysis
 * Run with: npx ts-node --esm src/test/analyze-opportunities.ts
 */

import { WeatherScanner } from '../polymarket/weather-scanner.js';
import { OpportunityDetector } from '../bot/opportunity-detector.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
    logger.info('Analyzing weather markets for opportunities...');
    logger.info(`Edge threshold: ${(config.minEdgeThreshold * 100).toFixed(0)}%`);

    const scanner = new WeatherScanner();
    const detector = new OpportunityDetector();

    try {
        // Scan markets
        const allMarkets = await scanner.scanForWeatherMarkets();
        const actionableMarkets = scanner.filterActionableMarkets(allMarkets);

        console.log(`\nFound ${allMarkets.length} weather markets, ${actionableMarkets.length} actionable\n`);

        // Analyze each actionable market
        for (const market of actionableMarkets) {
            console.log('='.repeat(70));
            console.log(`Market: ${market.market.question}`);
            console.log(`City: ${market.city}, Metric: ${market.metricType}`);
            console.log(`Threshold: ${market.threshold || 'N/A'} ${market.thresholdUnit || ''} (${market.comparisonType || 'N/A'})`);
            console.log(`Target Date: ${market.targetDate?.toLocaleDateString() || 'N/A'}`);
            console.log(`Current Market: YES ${(market.yesPrice * 100).toFixed(1)}% / NO ${(market.noPrice * 100).toFixed(1)}%`);

            const opportunity = await detector.analyzeMarket(market);

            if (opportunity) {
                console.log(`\nWeather Analysis (${opportunity.weatherDataSource}):`);
                console.log(`  Forecast Value: ${opportunity.forecastValue || 'N/A'} ${opportunity.forecastValueUnit || ''}`);
                console.log(`  Forecast Probability: ${(opportunity.forecastProbability * 100).toFixed(1)}%`);
                console.log(`  Market Probability: ${(opportunity.marketProbability * 100).toFixed(1)}%`);
                console.log(`  Edge: ${(opportunity.edge * 100).toFixed(1)}%`);
                console.log(`  Confidence: ${(opportunity.confidence * 100).toFixed(0)}%`);

                if (opportunity.action !== 'none') {
                    console.log(`\n  *** OPPORTUNITY: ${opportunity.action.toUpperCase()} ***`);
                    console.log(`  Reason: ${opportunity.reason}`);
                } else {
                    console.log(`\n  No opportunity (edge below threshold)`);
                }
            } else {
                console.log(`\n  Could not analyze this market`);
            }
            console.log('');
        }

    } catch (error) {
        logger.error('Analysis failed', { error: (error as Error).message });
        process.exit(1);
    }
}

main().catch(console.error);
