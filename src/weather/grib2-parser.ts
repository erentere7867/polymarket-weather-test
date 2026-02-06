/**
 * GRIB2 Parser - ULTRA HIGH PERFORMANCE VERSION
 * Uses wgrib2 with parallel execution for maximum speed
 * Target: <200ms parsing time for all cities
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import {
    ModelType,
    ParsedGRIBData,
    GridPointData,
    CityGRIBData,
    GRIBVariable,
    Coordinates,
    KNOWN_CITIES,
} from './types.js';
import { logger } from '../logger.js';

const execAsync = promisify(exec);

// Maximum parallel wgrib2 executions - tune based on CPU cores
const MAX_PARALLEL_WGRIB2 = 8;

/**
 * Parse options for GRIB2 parsing
 */
export interface ParseOptions {
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
}

/**
 * GRIB2 Parser result with city data
 */
export interface GRIBParseResult {
    model: ModelType;
    cycleHour: number;
    forecastHour: number;
    validTime: Date;
    cityData: CityGRIBData[];
    metadata: {
        fileSize: number;
        downloadTimeMs: number;
        parseTimeMs: number;
    };
}

/**
 * GRIB2 Parser - Optimized for sub-200ms parsing
 * Extracts specific variables for target cities using parallel wgrib2 execution
 */
export class GRIB2Parser {
    private useWgrib2: boolean;
    private tempDir: string;
    private cityCoordinates: Map<string, Coordinates>;
    // Pre-computed city ID mappings for zero-allocation lookups
    private cityIdMap: Map<string, string>;

    constructor() {
        this.useWgrib2 = this.checkWgrib2Available();
        // Use RAM-backed tmpfs on Linux for faster temp file I/O
        this.tempDir = this.selectTempDir();

        // Pre-compute city coordinates and IDs at startup
        this.cityCoordinates = new Map();
        this.cityIdMap = new Map();
        for (const city of KNOWN_CITIES) {
            this.cityCoordinates.set(city.name, city.coordinates);
            // Pre-compute normalized city ID to avoid regex at runtime
            this.cityIdMap.set(city.name, city.name.toLowerCase().replace(/\s+/g, '_'));
        }
    }

    /**
     * Select the fastest available temp directory
     * Prefers RAM-backed tmpfs (/dev/shm) on Linux for zero disk I/O
     */
    private selectTempDir(): string {
        if (platform() === 'linux') {
            const shmPath = '/dev/shm';
            try {
                if (existsSync(shmPath)) {
                    logger.info('[GRIB2Parser] Using /dev/shm (tmpfs) for temp files');
                    return shmPath;
                }
            } catch {
                // Fall through to default
            }
        }
        return tmpdir();
    }

    /**
     * Parse a GRIB2 buffer and extract data for target cities
     * Optimized: Uses parallel extraction for maximum speed
     */
    public async parse(buffer: Buffer, options: ParseOptions): Promise<GRIBParseResult> {
        const parseStart = Date.now();

        // Write buffer to temp file asynchronously
        const tempFile = join(this.tempDir, `grib_${Date.now()}_${Math.random().toString(36).slice(2)}.grib2`);
        const writePromise = fs.writeFile(tempFile, buffer);

        try {
            await writePromise;

            let cityData: CityGRIBData[];

            // Use wgrib2 for NCEP models (HRRR, RAP, GFS) where we know the variable mapping
            // Use ecCodes for ECMWF as it reliably handles ECMWF shortNames (2t, 10u, etc.)
            if (this.useWgrib2 && options.model !== 'ECMWF') {
                // Use parallel extraction for maximum speed
                cityData = await this.parseWithWgrib2Parallel(tempFile, options);
            } else {
                cityData = await this.parseWithEcCodes(tempFile, options);
            }

            const parseTimeMs = Date.now() - parseStart;

            // Calculate valid time from cycle hour and forecast hour
            const validTime = this.calculateValidTime(options.cycleHour, options.forecastHour);

            return {
                model: options.model,
                cycleHour: options.cycleHour,
                forecastHour: options.forecastHour,
                validTime,
                cityData,
                metadata: {
                    fileSize: buffer.length,
                    downloadTimeMs: 0, // Set by caller
                    parseTimeMs,
                },
            };
        } finally {
            // Fire-and-forget cleanup - don't await
            fs.unlink(tempFile).catch(() => { });
        }
    }

    /**
     * Parse using wgrib2 with a SINGLE process call for ALL cities
     * Key optimization: one wgrib2 invocation with multiple -lon flags
     * eliminates 12 process spawns (~80ms saved)
     */
    private async parseWithWgrib2Parallel(filePath: string, options: ParseOptions): Promise<CityGRIBData[]> {
        return this.runWgrib2BatchAllCities(filePath);
    }

    /**
     * Extract ALL cities in a single wgrib2 process call
     * Uses multiple -lon flags to extract all locations at once
     */
    private async runWgrib2BatchAllCities(filePath: string): Promise<CityGRIBData[]> {
        // Match any of the variables we need
        const matchers = [
            '(:TMP:2 m above ground:)',
            '(:UGRD:10 m above ground:)',
            '(:VGRD:10 m above ground:)',
            '(:APCP:surface:)'
        ].join('|');

        // Build multiple -lon flags, one per city
        const lonFlags = KNOWN_CITIES.map(city => `-lon ${city.coordinates.lon} ${city.coordinates.lat}`).join(' ');

        const command = `wgrib2 "${filePath}" -match "${matchers}" ${lonFlags}`;

        try {
            const { stdout } = await execAsync(command, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });

            // Initialize per-city results
            const cityResults = new Map<number, { TMP: number | null; UGRD: number | null; VGRD: number | null; APCP: number | null }>();
            for (let i = 0; i < KNOWN_CITIES.length; i++) {
                cityResults.set(i, { TMP: null, UGRD: null, VGRD: null, APCP: null });
            }

            // Parse output: each matched record produces one line per -lon flag
            // Format: "recNum:offset:date VAR LEVEL:lon=X,lat=Y,val=Z"
            // With multiple -lon flags, each record outputs N lines (one per -lon)
            const lines = stdout.trim().split('\n');

            // Group lines: for each matched variable, wgrib2 outputs KNOWN_CITIES.length lines
            const cityCount = KNOWN_CITIES.length;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;

                // Determine which variable this line belongs to
                let varName: string | null = null;
                if (line.includes(':TMP:2 m above ground:')) varName = 'TMP';
                else if (line.includes(':UGRD:10 m above ground:')) varName = 'UGRD';
                else if (line.includes(':VGRD:10 m above ground:')) varName = 'VGRD';
                else if (line.includes(':APCP:surface:')) varName = 'APCP';

                if (!varName) continue;

                // Extract val from "val=X" pattern
                const valMatch = line.match(/val=([\-\d.eE+]+)/);
                if (!valMatch) continue;
                const val = parseFloat(valMatch[1]);
                if (isNaN(val)) continue;

                // Determine which city this line corresponds to by matching lon/lat
                const lonMatch = line.match(/lon=([\-\d.]+),lat=([\-\d.]+)/);
                if (!lonMatch) continue;
                const outLon = parseFloat(lonMatch[1]);
                const outLat = parseFloat(lonMatch[2]);

                // Find closest city (wgrib2 snaps to nearest grid point)
                let bestCityIdx = -1;
                let bestDist = Infinity;
                for (let c = 0; c < cityCount; c++) {
                    const city = KNOWN_CITIES[c];
                    // Normalize lon to 0-360 for comparison (wgrib2 may output 0-360)
                    let cityLon = city.coordinates.lon;
                    if (cityLon < 0) cityLon += 360;
                    let compLon = outLon;
                    if (compLon < 0) compLon += 360;
                    const dLon = compLon - cityLon;
                    const dLat = outLat - city.coordinates.lat;
                    const dist = dLon * dLon + dLat * dLat;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestCityIdx = c;
                    }
                }

                if (bestCityIdx >= 0 && bestDist < 16.0) { // Within ~4 degrees tolerance (was 2 degrees)
                    const cr = cityResults.get(bestCityIdx)!;
                    if (varName === 'TMP') cr.TMP = val;
                    else if (varName === 'UGRD') cr.UGRD = val;
                    else if (varName === 'VGRD') cr.VGRD = val;
                    else if (varName === 'APCP') cr.APCP = val;
                }
            }

            // Convert results to CityGRIBData
            const cityData: CityGRIBData[] = [];
            for (let i = 0; i < KNOWN_CITIES.length; i++) {
                const city = KNOWN_CITIES[i];
                const r = cityResults.get(i)!;

                if (r.TMP === null) continue; // Need at least temperature

                const windSpeedMps = (r.UGRD !== null && r.VGRD !== null)
                    ? Math.sqrt(r.UGRD * r.UGRD + r.VGRD * r.VGRD)
                    : 0;
                const windDirection = (r.UGRD !== null && r.VGRD !== null)
                    ? (Math.atan2(r.VGRD, r.UGRD) * 180 / Math.PI + 360) % 360
                    : 0;

                cityData.push({
                    cityName: city.name,
                    coordinates: city.coordinates,
                    temperatureC: r.TMP,
                    temperatureF: (r.TMP * 9 / 5) + 32,
                    windSpeedMps,
                    windSpeedMph: windSpeedMps * 2.23694,
                    windDirection,
                    totalPrecipitationMm: r.APCP ?? 0,
                    totalPrecipitationIn: (r.APCP ?? 0) / 25.4,
                    precipitationRateMmHr: r.APCP ?? 0,
                });
            }

            return cityData;
        } catch (error) {
            logger.error(`[GRIB2Parser] wgrib2 batch extraction failed: ${error}`);
            return [];
        }
    }

    /**
     * Run task factories with proper concurrency limit
     * Uses factory functions to ensure tasks don't start until a slot is available
     */
    private async runWithConcurrencyLimit<T>(
        factories: (() => Promise<T>)[],
        limit: number
    ): Promise<T[]> {
        const results: T[] = new Array(factories.length);
        let nextIndex = 0;

        async function worker(): Promise<void> {
            while (nextIndex < factories.length) {
                const idx = nextIndex++;
                results[idx] = await factories[idx]();
            }
        }

        // Spawn `limit` workers
        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(limit, factories.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    }

    /**
     * Parse using ecCodes (fallback) - per-city extraction
     * Runs 4 variables × 13 cities = 52 grib_get calls with concurrency control
     * grib_get only supports one -l flag, so we must call once per city per variable
     */
    private async parseWithEcCodes(filePath: string, options: ParseOptions): Promise<CityGRIBData[]> {
        logger.info('[GRIB2Parser] Using ecCodes (grib_get) for parsing');

        // Run all 4 variable extractions in parallel; each internally spawns per-city calls
        const shortNames = ['2t', '10u', '10v', 'tp'] as const;
        const factories = shortNames.map(sn => () => this.runGribGetAllCities(filePath, sn));
        const [tempResults, uWindResults, vWindResults, precipResults] =
            await this.runWithConcurrencyLimit(factories, 4);

        // Log extraction results for debugging
        const tempCount = tempResults.filter(v => v !== null).length;
        const windCount = uWindResults.filter(v => v !== null).length;
        logger.info(`[GRIB2Parser] ecCodes extraction: ${tempCount}/${KNOWN_CITIES.length} cities got temperature, ${windCount} got wind`);

        // Build city data from combined results
        const cityData: CityGRIBData[] = [];
        for (let i = 0; i < KNOWN_CITIES.length; i++) {
            const city = KNOWN_CITIES[i];
            const temp = tempResults[i] ?? null;
            const uWind = uWindResults[i] ?? null;
            const vWind = vWindResults[i] ?? null;
            const precip = precipResults[i] ?? null;

            if (temp === null) {
                logger.warn(`[GRIB2Parser] No temperature data for ${city.name} (lat=${city.coordinates.lat}, lon=${city.coordinates.lon})`);
                continue;
            }

            // Kelvin to Celsius
            const temperatureC = temp - 273.15;
            const windSpeedMps = (uWind !== null && vWind !== null)
                ? Math.sqrt(uWind * uWind + vWind * vWind)
                : 0;
            const windDirection = (uWind !== null && vWind !== null)
                ? (Math.atan2(vWind, uWind) * 180 / Math.PI + 360) % 360
                : 0;

            cityData.push({
                cityName: city.name,
                coordinates: city.coordinates,
                temperatureC,
                temperatureF: (temperatureC * 9 / 5) + 32,
                windSpeedMps,
                windSpeedMph: windSpeedMps * 2.23694,
                windDirection,
                totalPrecipitationMm: precip ?? 0,
                totalPrecipitationIn: (precip ?? 0) / 25.4,
                precipitationRateMmHr: precip ?? 0,
            });
        }

        return cityData;
    }

    /**
     * Extract a single variable for ALL cities using per-city grib_get calls
     * grib_get only supports a single -l flag per invocation, so we run
     * one call per city in parallel for correct results.
     * Returns an array of values indexed by city order in KNOWN_CITIES
     */
    private async runGribGetAllCities(
        filePath: string,
        shortName: string
    ): Promise<(number | null)[]> {
        const factories = KNOWN_CITIES.map((city) => () => {
            const { lat, lon } = city.coordinates;
            // Quote the -l argument to handle negative lat/lon; mode=1 = nearest grid point
            const command = `grib_get -w shortName=${shortName} -l "${lat},${lon},1" "${filePath}"`;

            return execAsync(command, { timeout: 15000, maxBuffer: 1024 * 1024 })
                .then(({ stdout }) => {
                    const values = stdout.trim().split(/[\s\n]+/);
                    // Take the first value (first matching GRIB message)
                    if (values.length > 0) {
                        const val = parseFloat(values[0]);
                        return isNaN(val) ? null : val;
                    }
                    return null;
                })
                .catch(() => {
                    // grib_get exits with error if no messages match the filter
                    // (e.g. tp may not exist in analysis files) — this is expected
                    return null;
                });
        });

        // Run all cities in parallel (13 concurrent processes, each is a fast point lookup)
        return this.runWithConcurrencyLimit(factories, KNOWN_CITIES.length);
    }

    /**
     * Check if wgrib2 is available
     */
    private checkWgrib2Available(): boolean {
        try {
            execSync('wgrib2 -version', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Calculate valid time from cycle and forecast hour
     */
    private calculateValidTime(cycleHour: number, forecastHour: number): Date {
        const now = new Date();
        const validTime = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            cycleHour,
            0,
            0
        ));
        validTime.setHours(validTime.getHours() + forecastHour);
        return validTime;
    }

    /**
     * Get pre-computed city ID for zero-allocation lookups
     */
    public getCityId(cityName: string): string | undefined {
        return this.cityIdMap.get(cityName);
    }
}
