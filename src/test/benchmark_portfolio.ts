
import { PortfolioSimulator } from '../simulation/portfolio.js';
import { TradingOpportunity, ParsedWeatherMarket } from '../polymarket/types.js';

function createMockOpportunity(tokenId: string): TradingOpportunity {
    const market: ParsedWeatherMarket = {
        market: {
            id: `market_${tokenId}`,
            conditionId: `cond_${tokenId}`,
            slug: `slug_${tokenId}`,
            question: `Will it rain? ${tokenId}`,
            outcomes: ['Yes', 'No'],
            outcomePrices: ['0.5', '0.5'],
            clobTokenIds: [tokenId, `no_${tokenId}`],
            active: true,
            closed: false
        },
        eventTitle: 'Weather Event',
        city: 'New York',
        metricType: 'precipitation',
        yesPrice: 0.5,
        noPrice: 0.5,
        yesTokenId: tokenId,
        noTokenId: `no_${tokenId}`
    };

    return {
        market,
        forecastProbability: 0.8,
        marketProbability: 0.5,
        edge: 0.3,
        action: 'buy_yes',
        confidence: 0.9,
        reason: 'Test',
        weatherDataSource: 'noaa',
        isGuaranteed: false
    };
}

async function runBenchmark() {
    const portfolio = new PortfolioSimulator(1_000_000_000); // Billion dollars to avoid cash limits

    const NUM_TOKENS = 1000;
    const POSITIONS_PER_TOKEN = 10;
    const TOTAL_POSITIONS = NUM_TOKENS * POSITIONS_PER_TOKEN;
    const NUM_UPDATES = 10000;

    console.log(`Setting up ${TOTAL_POSITIONS} positions (${NUM_TOKENS} tokens, ${POSITIONS_PER_TOKEN} positions/token)...`);
    const tokenIds: string[] = [];

    // Suppress logging during setup
    const originalConsoleLog = console.log;
    // console.log = () => {};
    // Actually, PortfolioSimulator uses a 'logger' imported from ../logger.js.
    // It might spam. But let's just run it.

    for (let i = 0; i < NUM_TOKENS; i++) {
        const tokenId = `token_${i}`;
        tokenIds.push(tokenId);

        for (let j = 0; j < POSITIONS_PER_TOKEN; j++) {
             const opp = createMockOpportunity(tokenId);
             // Use a large enough position size so it doesn't get skipped (<10)
             // And simulate execution ensures it goes through.
             portfolio.openPosition(opp, 1000);
        }
    }

    // console.log = originalConsoleLog;

    const actualPositions = portfolio.getOpenPositions().length;
    console.log(`Portfolio has ${actualPositions} open positions.`);

    if (actualPositions === 0) {
        console.error("Failed to open positions. Check logs.");
        return;
    }

    console.log(`Running ${NUM_UPDATES} updates...`);
    const start = process.hrtime();

    for (let i = 0; i < NUM_UPDATES; i++) {
        const tokenId = tokenIds[i % NUM_TOKENS];
        const newPrice = 0.1 + (Math.random() * 0.8);
        portfolio.updatePriceByToken(tokenId, newPrice);
    }

    const end = process.hrtime(start);
    const durationMs = (end[0] * 1000 + end[1] / 1e6);

    console.log(`Completed ${NUM_UPDATES} updates in ${durationMs.toFixed(2)}ms`);
    console.log(`Average time per update: ${(durationMs / NUM_UPDATES).toFixed(4)}ms`);
    console.log(`Updates per second: ${(NUM_UPDATES / (durationMs / 1000)).toFixed(2)}`);

    // Correctness check
    const checkToken = tokenIds[0];
    const checkPrice = 0.12345;
    portfolio.updatePriceByToken(checkToken, checkPrice);
    const positions = portfolio.getOpenPositions().filter(p => p.tokenId === checkToken);

    // We expect POSITIONS_PER_TOKEN positions
    if (positions.length !== POSITIONS_PER_TOKEN) {
        console.warn(`Warning: Expected ${POSITIONS_PER_TOKEN} positions for token, found ${positions.length}`);
    }

    const allUpdated = positions.every(p => Math.abs(p.currentPrice - checkPrice) < 0.00001);

    if (allUpdated && positions.length > 0) {
        console.log("✅ Verification Passed: Prices updated correctly.");
    } else {
        console.error("❌ Verification Failed: Prices not updated.");
        console.error(`Found ${positions.length} positions for token ${checkToken}`);
        if (positions.length > 0) {
             console.error(`First position price: ${positions[0].currentPrice}, expected ${checkPrice}`);
        }
    }
}

runBenchmark().catch(console.error);
