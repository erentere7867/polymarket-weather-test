/**
 * Test script: Fetch weather data
 * Run with: npx ts-node --esm src/test/fetch-weather.ts
 */

import { WeatherService } from '../weather/index.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
    logger.info('Testing weather data fetching...');

    const weatherService = new WeatherService();
    const cities = ['New York City', 'Chicago', 'Los Angeles', 'Washington DC'];

    for (const city of cities) {
        console.log('\n' + '='.repeat(60));
        console.log(`Fetching weather for: ${city}`);

        try {
            const forecast = await weatherService.getForecastByCity(city);

            console.log(`  Source: ${forecast.source}`);
            console.log(`  Location: ${forecast.locationName}`);
            console.log(`  Fetched at: ${forecast.fetchedAt.toISOString()}`);
            console.log(`  Hourly forecasts: ${forecast.hourly.length}`);

            // Show next 24 hours
            console.log('\n  Next 24 hours:');
            const next24 = forecast.hourly.slice(0, 24);

            for (const hour of next24) {
                const time = hour.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const date = hour.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                console.log(
                    `    ${date} ${time}: ${hour.temperatureF}°F, ` +
                    `Precip: ${hour.probabilityOfPrecipitation}%, ` +
                    `${hour.shortForecast || ''}`
                );
            }

            // Show expected high for today
            const today = new Date();
            const expectedHigh = await weatherService.getExpectedHigh(city, today);
            console.log(`\n  Expected high today: ${expectedHigh}°F`);

        } catch (error) {
            console.error(`  Error: ${(error as Error).message}`);
        }
    }
}

main().catch(console.error);
