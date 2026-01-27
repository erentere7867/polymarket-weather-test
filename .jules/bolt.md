## 2026-01-27 - Portfolio Update Bottleneck
**Learning:** The `PortfolioSimulator` was iterating over all positions (O(N)) for every market update (O(M)), resulting in O(M*N) complexity. With 10,000 positions, this took ~6.7 seconds per update cycle.
**Action:** Always index collections by their lookup key (e.g., `tokenId`) when frequent updates are expected. Implemented `positionsByToken` map and cached `totalPositionValue` to reduce complexity to O(1) per update.
