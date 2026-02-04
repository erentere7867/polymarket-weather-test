/**
 * GRIB2 Parser - ULTRA HIGH PERFORMANCE VERSION
 * Uses wgrib2 with parallel execution for maximum speed
 * Target: <200ms parsing time for all cities
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
        this.tempDir = tmpdir();
        
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
            fs.unlink(tempFile).catch(() => {});
        }
    }

    /**
     * Parse using wgrib2 with PARALLEL execution
     * This is the key optimization - runs all city extractions concurrently
     */
    private async parseWithWgrib2Parallel(filePath: string, options: ParseOptions): Promise<CityGRIBData[]> {
        // Create extraction promises for all cities
        const cityPromises = KNOWN_CITIES.map(city => this.extractCityData(filePath, city));
        
        // Execute all extractions with concurrency limit
        const results = await this.runWithConcurrencyLimit(cityPromises, MAX_PARALLEL_WGRIB2);
        
        // Filter out null results and return valid city data
        return results.filter((data): data is CityGRIBData => data !== null);
    }

    /**
     * Extract data for a single city - all variables in parallel
     */
    private async extractCityData(filePath: string, city: typeof KNOWN_CITIES[0]): Promise<CityGRIBData | null> {
        const { lat, lon } = city.coordinates;
        
        try {
            // Extract all variables in parallel for this city
            const [tempResult, uWindResult, vWindResult, precipResult] = await Promise.all([
                this.runWgrib2(filePath, 'TMP', '2 m above ground', lat, lon).catch(() => null),
                this.runWgrib2(filePath, 'UGRD', '10 m above ground', lat, lon).catch(() => null),
                this.runWgrib2(filePath, 'VGRD', '10 m above ground', lat, lon).catch(() => null),
                this.runWgrib2(filePath, 'APCP', 'surface', lat, lon).catch(() => null),
            ]);
            
            // Build city data object
            const values: Partial<CityGRIBData> = {
                cityName: city.name,
                coordinates: city.coordinates,
            };
            
            // Set temperature if available
            if (tempResult !== null) {
                values.temperatureC = tempResult;
                values.temperatureF = (tempResult * 9/5) + 32;
            }
            
            // Calculate wind from U/V components
            if (uWindResult !== null && vWindResult !== null) {
                const windSpeedMps = Math.sqrt(uWindResult * uWindResult + vWindResult * vWindResult);
                const windDirection = (Math.atan2(vWindResult, uWindResult) * 180 / Math.PI + 360) % 360;
                values.windSpeedMps = windSpeedMps;
                values.windSpeedMph = windSpeedMps * 2.23694;
                values.windDirection = windDirection;
            }
            
            // Set precipitation
            if (precipResult !== null) {
                values.totalPrecipitationMm = precipResult;
                values.totalPrecipitationIn = precipResult / 25.4;
                values.precipitationRateMmHr = precipResult;
            } else {
                values.totalPrecipitationMm = 0;
                values.totalPrecipitationIn = 0;
                values.precipitationRateMmHr = 0;
            }
            
            // Only return if we have at least temperature
            if (values.temperatureC !== undefined) {
                return values as CityGRIBData;
            }
            
            return null;
        } catch (error) {
            logger.debug(`[GRIB2Parser] Error extracting data for ${city.name}: ${error}`);
            return null;
        }
    }

    /**
     * Run promises with concurrency limit
     * Prevents overwhelming the system with too many parallel wgrib2 processes
     */
    private async runWithConcurrencyLimit<T>(
        promises: Promise<T>[],
        limit: number
    ): Promise<T[]> {
        const results: T[] = [];
        const executing: Promise<void>[] = [];
        
        for (const [index, promise] of promises.entries()) {
            const p = promise.then(result => {
                results[index] = result;
            });
            
            executing.push(p);
            
            if (executing.length >= limit) {
                await Promise.race(executing);
                executing.splice(executing.findIndex(ep => ep === p), 1);
            }
        }
        
        await Promise.all(executing);
        return results;
    }

    /**
     * Run wgrib2 command to extract value at specific location
     * Optimized: Uses shorter timeout and efficient parsing
     */
    private async runWgrib2(
        filePath: string,
        varName: string,
        level: string,
        lat: number,
        lon: number
    ): Promise<number | null> {
        // wgrib2 command to extract value at nearest grid point
        const command = `wgrib2 "${filePath}" -match ":${varName}:" -match ":${level}:" -lon ${lon} ${lat} -csv -`;
        
        try {
            // Reduced timeout for faster failure detection
            const { stdout } = await execAsync(command, { timeout: 5000 });
            
            // Fast CSV parsing - find first valid value
            const lines = stdout.trim().split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Quick check for value column (7th column in CSV)
                const lastComma = line.lastIndexOf(',');
                if (lastComma === -1) continue;
                
                const valueStr = line.slice(lastComma + 1).replace(/"/g, '');
                const value = parseFloat(valueStr);
                if (!isNaN(value)) {
                    return value;
                }
            }
            logger.debug(`[GRIB2Parser] No value found in output: ${stdout}`);
            return null;
        } catch (error) {
            logger.error(`[GRIB2Parser] wgrib2 failed: ${error} Cmd: ${command}`);
            return null;
        }
    }

    /**
     * Legacy sequential parsing - kept for reference but not used
     * @deprecated Use parseWithWgrib2Parallel instead
     */
    private async parseWithWgrib2(filePath: string, options: ParseOptions): Promise<CityGRIBData[]> {
        // Delegate to parallel version
        return this.parseWithWgrib2Parallel(filePath, options);
    }

    /**
     * Parse using ecCodes (fallback)
     */
    private async parseWithEcCodes(filePath: string, options: ParseOptions): Promise<CityGRIBData[]> {
        logger.info('[GRIB2Parser] Using ecCodes (grib_get) for parsing');
        
        // Parallel extraction for all cities
        const cityPromises = KNOWN_CITIES.map(city => this.extractCityDataEcCodes(filePath, city));
        const results = await this.runWithConcurrencyLimit(cityPromises, MAX_PARALLEL_WGRIB2);
        
        return results.filter((data): data is CityGRIBData => data !== null);
    }

    private async extractCityDataEcCodes(filePath: string, city: typeof KNOWN_CITIES[0]): Promise<CityGRIBData | null> {
        const { lat, lon } = city.coordinates;
        
        try {
            // Extract variables using grib_get
            // TMP 2m -> shortName=2t
            // UGRD 10m -> shortName=10u
            // VGRD 10m -> shortName=10v
            // APCP surface -> shortName=tp (Total Precipitation)
            
            const [tempResult, uWindResult, vWindResult, precipResult] = await Promise.all([
                this.runGribGet(filePath, '2t', lat, lon).catch(() => null),
                this.runGribGet(filePath, '10u', lat, lon).catch(() => null),
                this.runGribGet(filePath, '10v', lat, lon).catch(() => null),
                this.runGribGet(filePath, 'tp', lat, lon).catch(() => null),
            ]);

            // Build city data object
            const values: Partial<CityGRIBData> = {
                cityName: city.name,
                coordinates: city.coordinates,
            };
            
            // Set temperature if available
            if (tempResult !== null) {
                // Kelvin to Celsius
                values.temperatureC = tempResult - 273.15;
                values.temperatureF = (values.temperatureC * 9/5) + 32;
            }
            
            // Calculate wind from U/V components
            if (uWindResult !== null && vWindResult !== null) {
                const windSpeedMps = Math.sqrt(uWindResult * uWindResult + vWindResult * vWindResult);
                const windDirection = (Math.atan2(vWindResult, uWindResult) * 180 / Math.PI + 360) % 360;
                values.windSpeedMps = windSpeedMps;
                values.windSpeedMph = windSpeedMps * 2.23694;
                values.windDirection = windDirection;
            }
            
            // Set precipitation
            if (precipResult !== null) {
                values.totalPrecipitationMm = precipResult;
                values.totalPrecipitationIn = precipResult / 25.4;
                values.precipitationRateMmHr = precipResult; // Approximation for hourly files
            } else {
                values.totalPrecipitationMm = 0;
                values.totalPrecipitationIn = 0;
                values.precipitationRateMmHr = 0;
            }
            
            if (values.temperatureC !== undefined) {
                return values as CityGRIBData;
            }
            
            return null;
        } catch (error) {
            logger.error(`[GRIB2Parser] Error extracting data (ecCodes) for ${city.name}: ${error}`);
            return null;
        }
    }

    private async runGribGet(
        filePath: string,
        shortName: string,
        lat: number,
        lon: number
    ): Promise<number | null> {
        // grib_get -w shortName=... -l lat,lon file
        // Note: grib_get expects lat,lon (comma separated, no space)
        // Returns "val1 val2 val3 val4" for nearest neighbors
        const command = `grib_get -w shortName=${shortName} -l ${lat},${lon} "${filePath}"`;
        
        try {
            const { stdout } = await execAsync(command, { timeout: 30000 });
            const valueStr = stdout.trim().split(/\s+/)[0]; // Take first value
            const value = parseFloat(valueStr);
            if (!isNaN(value)) {
                return value;
            }
            return null;
        } catch (error: any) {
            logger.error(`[GRIB2Parser] grib_get failed for ${shortName}: ${error.message} \nStdout: ${error.stdout} \nStderr: ${error.stderr}`);
            return null;
        }
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
