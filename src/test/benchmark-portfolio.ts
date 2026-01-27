
import { PortfolioSimulator } from '../simulation/portfolio.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';

function createMockMarket(id: string, yesTokenId: string, noTokenId: string): ParsedWeatherMarket {
    return {
        market: {
            id,
            conditionId: 'cond_' + id,
            slug: 'slug-' + id,
            question: `Will it rain in Mock City ${id}?`,
            outcomes: ['Yes', 'No'],
            outcomePrices: ['0.5', '0.5'],
            clobTokenIds: [yesTokenId, noTokenId],
            active: true,
            closed: false,
        },
        eventTitle: 'Mock Event',
        city: 'Mock City',
        metricType: 'precipitation',
        targetDate: new Date(),
        yesPrice: 0.5,
        noPrice: 0.5,
        yesTokenId,
        noTokenId,
    };
}

function createMockOpportunity(market: ParsedWeatherMarket): TradingOpportunity {
    return {
        market,
        forecastProbability: 0.8,
        marketProbability: 0.5,
        edge: 0.3,
        action: 'buy_yes',
        confidence: 0.9,
        reason: 'Mock reason',
        weatherDataSource: 'noaa',
        isGuaranteed: false,
        snapshotPrice: 0.5
    };
}

async function runBenchmark() {
    const portfolio = new PortfolioSimulator(10_000_000); // Plenty of cash
    const markets: ParsedWeatherMarket[] = [];
    const NUM_POSITIONS = 10000;

    console.log(`Setting up ${NUM_POSITIONS} positions...`);
    const startSetup = performance.now();

    for (let i = 0; i < NUM_POSITIONS; i++) {
        const yesTokenId = `yes_${i}`;
        const noTokenId = `no_${i}`;
        const market = createMockMarket(`m_${i}`, yesTokenId, noTokenId);
        markets.push(market);

        const opp = createMockOpportunity(market);
        portfolio.openPosition(opp, 100); // Small size to ensure we don't run out of cash
    }

    const endSetup = performance.now();
    console.log(`Setup complete in ${(endSetup - startSetup).toFixed(2)}ms`);

    // Warmup
    portfolio.getTotalValue();

    // Benchmark getTotalValue
    console.log('Benchmarking getTotalValue...');
    const startValue = performance.now();
    const value = portfolio.getTotalValue();
    const endValue = performance.now();
    console.log(`getTotalValue took ${(endValue - startValue).toFixed(4)}ms. Value: ${value.toFixed(2)}`);

    // Benchmark updatePrices
    console.log('Benchmarking updatePrices...');

    // Update prices for all markets
    for (const market of markets) {
        market.yesPrice = 0.6; // Price moved
        market.noPrice = 0.4;
    }

    const startUpdate = performance.now();
    portfolio.updatePrices(markets);
    const endUpdate = performance.now();
    console.log(`updatePrices took ${(endUpdate - startUpdate).toFixed(4)}ms`);

    // Verify
    const finalValue = portfolio.getTotalValue();
    console.log(`Final value: ${finalValue.toFixed(2)}`);

    // Simple correctness check
    // We bought YES at ~0.5 (with slippage/fees maybe slightly different but let's say 0.5)
    // Price moved to 0.6.
    // Should have profit.
    if (finalValue <= value) {
        console.error('ERROR: Value should have increased!');
    } else {
        console.log('Correctness Check: Value increased as expected.');
    }
}

runBenchmark().catch(console.error);
