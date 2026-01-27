export class RateLimiter {
    private callCounts: Map<string, number> = new Map();
    // Keys should match the normalized (lowercased) source names from clients
    private dailyLimits: Map<string, number> = new Map([
        ['tomorrow.io', 500],
        ['weatherapi', 30000],
        ['weatherbit', 500],
        ['visual crossing', 1000],
        ['meteosource', 400]
    ]);

    // Reset stats daily? For now, simplistic in-memory counter. 
    // In prod, should persist or reset at midnight.
    // Let's implement a simple reset if 24h passed.
    private lastReset: number = Date.now();

    constructor() {
        // Attempt to load limits from config/env if needed, but hardcoded defaults are safe start.
    }

    canCall(sourceName: string): boolean {
        this.checkReset();
        const source = sourceName.toLowerCase();

        // Open-Meteo and NOAA are unlimited (free APIs)
        if (source === 'open-meteo' || source === 'noaa') return true;

        const count = this.callCounts.get(source) || 0;
        const limit = this.dailyLimits.get(source) || Infinity;

        return count < limit;
    }

    increment(sourceName: string): void {
        const source = sourceName.toLowerCase();
        const count = this.callCounts.get(source) || 0;
        this.callCounts.set(source, count + 1);
    }

    private checkReset(): void {
        const now = Date.now();
        // Reset if more than 24 hours passed
        if (now - this.lastReset > 24 * 60 * 60 * 1000) {
            this.callCounts.clear();
            this.lastReset = now;
        }
    }

    getStats(): { [key: string]: number } {
        const stats: { [key: string]: number } = {};
        for (const [key, value] of this.callCounts.entries()) {
            stats[key] = value;
        }
        return stats;
    }
}
