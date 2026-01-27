## 2026-01-27 - Portfolio Update Bottleneck
**Learning:** The `PortfolioSimulator` was iterating over all positions (O(N)) for every market update (O(M)), resulting in O(M*N) complexity. With 10,000 positions, this took ~6.7 seconds per update cycle.
**Action:** Always index collections by their lookup key (e.g., `tokenId`) when frequent updates are expected. Implemented `positionsByToken` map and cached `totalPositionValue` to reduce complexity to O(1) per update.

## 2026-02-05 - Regex Instantiation Bottleneck
**Learning:** Creating `new RegExp` inside a high-frequency loop (e.g., scanning thousands of markets) is extremely expensive. In `WeatherScanner`, creating regexes for 20 cities per market resulted in significant CPU overhead.
**Action:** Pre-compile static regex patterns at the module or class level. Moving regex creation outside the loop reduced execution time by ~8x in benchmarks.
