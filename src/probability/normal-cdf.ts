/**
 * Shared Normal CDF Implementation
 * Abramowitz and Stegun approximation (formula 26.2.17)
 * Accurate to within 7.5e-8
 * 
 * Used across the codebase for consistent probability calculations.
 * Replaces multiple inconsistent implementations.
 */

/**
 * Standard normal cumulative distribution function
 * P(X <= x) where X ~ N(0,1)
 * 
 * @param x - The z-score
 * @returns Probability between 0 and 1
 */
export function normalCDF(x: number): number {
    // Handle extreme values
    if (x < -6) return 0;
    if (x > 6) return 1;

    const b1 = 0.319381530;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    const p = 0.2316419;
    const c = 0.39894228;

    const absX = Math.abs(x);
    const t = 1 / (1 + p * absX);

    const phi = c * Math.exp(-(x * x) / 2);
    const poly = b1 * t + b2 * t * t + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5);

    let result = 1 - phi * poly;

    if (x < 0) {
        result = 1 - result;
    }

    return Math.max(0, Math.min(1, result));
}

/**
 * Calculate the probability that a forecast value exceeds a threshold,
 * given Gaussian uncertainty.
 * 
 * @param forecastValue - The forecasted value (e.g., temperature in °F)
 * @param threshold - The market threshold
 * @param uncertainty - Standard deviation of forecast error (e.g., 3°F)
 * @returns Probability between 0 and 1 that the actual value >= threshold
 */
export function exceedanceProbability(
    forecastValue: number,
    threshold: number,
    uncertainty: number
): number {
    if (uncertainty <= 0) {
        return forecastValue >= threshold ? 1 : 0;
    }
    const z = (forecastValue - threshold) / uncertainty;
    // P(actual >= threshold) = P(Z >= -z) = 1 - CDF(-z) = CDF(z)
    return normalCDF(z);
}
