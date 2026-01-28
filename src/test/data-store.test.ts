
import { DataStore } from '../realtime/data-store.js';
import { ParsedWeatherMarket } from '../polymarket/types.js';

// Minimal mock
const mockMarket: ParsedWeatherMarket = {
    market: { id: 'mkt1' } as any,
    eventTitle: 'Test Event',
    city: 'New York',
    metricType: 'temperature_high',
    yesPrice: 0.5,
    noPrice: 0.5,
    yesTokenId: 'yes1',
    noTokenId: 'no1'
};

async function testDataStore() {
    console.log('Testing DataStore...');
    const store = new DataStore();
    store.addMarket(mockMarket);

    // Test 1: Update Price
    store.updatePrice('yes1', 0.55);
    const state = store.getMarketState('mkt1');
    if (state?.market.yesPrice !== 0.55) throw new Error('Price not updated');
    console.log('✅ Price update works');

    // Test 2: Velocity
    const store2 = new DataStore();
    store2.addMarket(mockMarket);

    const now = new Date();
    const t0 = new Date(now.getTime() - 20000);
    const t1 = new Date(now.getTime() - 10000);
    const t2 = now;

    store2.updatePrice('yes1', 0.50, t0);
    store2.updatePrice('yes1', 0.55, t1); // +0.05 in 10s
    store2.updatePrice('yes1', 0.60, t2); // +0.05 in 10s

    // Window is 1 min. All points are within window.
    // First: t0 (0.50). Last: t2 (0.60). Diff: 20s.
    // Vel: 0.10 / 20 = 0.005.

    const v = store2.getMarketState('mkt1')!.priceHistory.yes.velocity;
    if (Math.abs(v - 0.005) > 0.0001) throw new Error(`Velocity wrong. Expected 0.005, got ${v}`);
    console.log('✅ Velocity calculation works');

    // Test 2b: Velocity with old points outside window
    const store2b = new DataStore();
    store2b.addMarket(mockMarket);

    const tOld = new Date(now.getTime() - 70000); // 70s ago (outside 1m window)
    const tInside = new Date(now.getTime() - 10000); // 10s ago
    const tNow = now;

    store2b.updatePrice('yes1', 0.40, tOld);
    store2b.updatePrice('yes1', 0.50, tInside);
    store2b.updatePrice('yes1', 0.60, tNow);

    // Window start: T-60s.
    // tOld is T-70s.
    // First valid point > T-60s is tInside (T-10s).
    // Last is tNow (T-0).
    // Diff: 10s. Price diff: 0.60 - 0.50 = 0.10.
    // Velocity: 0.10 / 10 = 0.01.

    const v2 = store2b.getMarketState('mkt1')!.priceHistory.yes.velocity;
    if (Math.abs(v2 - 0.01) > 0.0001) throw new Error(`Velocity 2b wrong. Expected 0.01, got ${v2}`);
    console.log('✅ Velocity window filtering works');

    // Test 3: Pruning
    const store3 = new DataStore();
    store3.addMarket(mockMarket);

    // Add very old point
    const old = new Date(now.getTime() - 61 * 60 * 1000); // 61 mins ago
    store3.updatePrice('yes1', 0.1, old);

    // Add new point triggers pruning
    store3.updatePrice('yes1', 0.2, now);

    const hist = store3.getMarketState('mkt1')!.priceHistory.yes.history;
    if (hist.length !== 1) throw new Error(`Pruning failed. Length: ${hist.length}`);
    if (hist[0].price !== 0.2) throw new Error('Wrong point remaining');
    console.log('✅ Pruning works');
}

testDataStore().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
