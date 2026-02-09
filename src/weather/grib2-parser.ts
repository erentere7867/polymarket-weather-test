/**
 * GRIB2 Parser - ULTRA HIGH PERFORMANCE VERSION
 * Uses wgrib2 with parallel execution for maximum speed
 * Target: <200ms parsing time for all cities
 */

import { exec, execSync, spawn } from 'child_process';
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
import { config } from '../config.js';

const execAsync = promisify(exec);

// Maximum parallel wgrib2 executions - tune based on CPU cores
const MAX_PARALLEL_WGRIB2 = 8;

// Cache the resolved wgrib2 path
let WGRIB2_PATH: string | null = null;

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
    
    // Pre-computed typed arrays for ultra-fast distance calculations
    private cityLats: Float64Array;
    private cityLons: Float64Array;

    constructor() {
        this.useWgrib2 = this.checkWgrib2Available();
        // Use RAM-backed tmpfs on Linux for faster temp file I/O
        this.tempDir = this.selectTempDir();

        // Pre-compute city coordinates and IDs at startup
        this.cityCoordinates = new Map();
        this.cityIdMap = new Map();
        
        const numCities = KNOWN_CITIES.length;
        this.cityLats = new Float64Array(numCities);
        this.cityLons = new Float64Array(numCities);

        for (let i = 0; i < numCities; i++) {
            const city = KNOWN_CITIES[i];
            this.cityCoordinates.set(city.name, city.coordinates);
            // Pre-compute normalized city ID to avoid regex at runtime
            this.cityIdMap.set(city.name, city.name.toLowerCase().replace(/\s+/g, '_'));
            
            this.cityLats[i] = city.coordinates.lat;
            this.cityLons[i] = city.coordinates.lon;
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
     * Determine which cities to process based on model type
     * HRRR and RAP are US regional models, only fetch US cities
     * GFS and ECMWF are global models, fetch all cities
     */
    private getCitiesForModel(model: ModelType): typeof KNOWN_CITIES {
        if (model === 'HRRR' || model === 'RAP') {
            // Regional US models - only US cities
            const usCities = KNOWN_CITIES.filter(city => city.country === 'US');
            logger.debug(`[GRIB2Parser] ${model} is a regional model, processing ${usCities.length} US cities only`);
            return usCities;
        }
        // Global models - all cities
        logger.debug(`[GRIB2Parser] ${model} is a global model, processing all ${KNOWN_CITIES.length} cities`);
        return KNOWN_CITIES;
    }

    /**
     * Parse a GRIB2 buffer and extract data for target cities
     * Optimized: Uses parallel extraction for maximum speed
     */
    public async parse(buffer: Buffer, options: ParseOptions): Promise<GRIBParseResult> {
        const parseStart = Date.now();

        // Get cities based on model type
        const citiesToProcess = this.getCitiesForModel(options.model);

        // Write buffer to temp file asynchronously
        const tempFile = join(this.tempDir, `grib_${Date.now()}_${Math.random().toString(36).slice(2)}.grib2`);
        const writePromise = fs.writeFile(tempFile, buffer);

        try {
            await writePromise;
            if (logger.levels[logger.level] >= logger.levels.debug) {
                logger.debug(`[GRIB2Parser] tempFile ${tempFile} written, size: ${buffer.length} bytes`);
            }

            // Quick validation: Show what fields are available in the file
            if (logger.levels[logger.level] >= logger.levels.debug) {
                try {
                    const { execSync } = await import('child_process');
                    const inventory = execSync(`${this.getWgrib2Path()} "${tempFile}" 2>/dev/null | head -5`, { encoding: 'utf8', timeout: 5000 });
                    logger.debug(`[GRIB2Parser] GRIB inventory: ${inventory.split('\n').length} messages found`);
                } catch (e) {
                    logger.debug(`[GRIB2Parser] Could not get GRIB inventory: ${e}`);
                }
            }

            let cityData: CityGRIBData[];

            // Use wgrib2 if available (supports NCEP and ECMWF with updated matchers)
            // Fallback to ecCodes only if wgrib2 is not available
            if (this.useWgrib2) {
                // Use parallel extraction for maximum speed
                cityData = await this.parseWithWgrib2Parallel(tempFile, options, citiesToProcess);
                
                // If wgrib2 returned no data (e.g. format not supported), fallback to ecCodes
                if (cityData.length === 0) {
                    logger.warn('[GRIB2Parser] wgrib2 returned no data, falling back to ecCodes');
                    cityData = await this.parseWithEcCodes(tempFile, options, citiesToProcess);
                }
            } else {
                cityData = await this.parseWithEcCodes(tempFile, options, citiesToProcess);
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
    private async parseWithWgrib2Parallel(filePath: string, options: ParseOptions, citiesToProcess: typeof KNOWN_CITIES): Promise<CityGRIBData[]> {
        return this.runWgrib2BatchAllCities(filePath, options.model, citiesToProcess);
    }

    /**
     * Parse grid bounds from wgrib2 -grid output
     */
    private parseGridBounds(gridOutput: string): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
        // Match Lambert Conformal: Lat1 X, Lon1 Y
        const lat1Match = gridOutput.match(/Lat1\s+(-?\d+\.?\d*)/);
        const lon1Match = gridOutput.match(/Lon1\s+(-?\d+\.?\d*)/);
        
        if (lat1Match && lon1Match) {
            const lat1 = parseFloat(lat1Match[1]);
            const lon1 = parseFloat(lon1Match[1]);
            
            // For Lambert Conformal, estimate bounds (HRRR is roughly 3000km x 3000km)
            // Approximate: 3km * 1059 grid points = ~3180km in y direction (~28 degrees)
            // Approximate: 3km * 1799 grid points = ~5400km in x direction (~48 degrees at mid-lat)
            return {
                minLat: lat1,
                maxLat: lat1 + 35, // Conservative estimate
                minLon: lon1,
                maxLon: lon1 + 60  // Conservative estimate
            };
        }
        
        // Match lat-lon grid format
        const latRangeMatch = gridOutput.match(/lat\s+(-?\d+\.?\d+)\s+to\s+(-?\d+\.?\d*)/i);
        const lonRangeMatch = gridOutput.match(/lon\s+(-?\d+\.?\d+)\s+to\s+(-?\d+\.?\d*)/i);
        
        if (latRangeMatch && lonRangeMatch) {
            return {
                minLat: Math.min(parseFloat(latRangeMatch[1]), parseFloat(latRangeMatch[2])),
                maxLat: Math.max(parseFloat(latRangeMatch[1]), parseFloat(latRangeMatch[2])),
                minLon: parseFloat(lonRangeMatch[1]),
                maxLon: parseFloat(lonRangeMatch[2])
            };
        }
        
        return null;
    }

    /**
     * Extract ALL cities in a single wgrib2 process call
     * Uses multiple -lon flags to extract all locations at once
     * 
     * OPTIMIZATION: Uses spawn + stream processing to avoid buffering massive stdout
     */
    private async runWgrib2BatchAllCities(filePath: string, model: ModelType, citiesToProcess: typeof KNOWN_CITIES): Promise<CityGRIBData[]> {
        // Use simpler matcher patterns - wgrib2 uses POSIX regex
        // Fixed: removed :.*: between variable and level (they're adjacent in inventory format)
        const matchers = 'TMP:2 m above ground|UGRD:10 m above ground|VGRD:10 m above ground|APCP:surface';

        // Only check bounds for regional models (HRRR, RAP)
        // Global models (GFS, ECMWF) cover all cities by definition
        const isGlobalModel = model === 'GFS' || model === 'ECMWF';

        // Get grid bounds to filter cities within domain (only for regional models)
        let bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null;
        if (!isGlobalModel && logger.levels[logger.level] >= logger.levels.debug) {
            try {
                const { execSync } = await import('child_process');
                const gridInfo = execSync(`${this.getWgrib2Path()} "${filePath}" -grid 2>/dev/null | head -5`, { encoding: 'utf8', timeout: 5000 });
                bounds = this.parseGridBounds(gridInfo);
                if (bounds) {
                    logger.debug(`[GRIB2Parser] Grid bounds: lat ${bounds.minLat}-${bounds.maxLat}, lon ${bounds.minLon}-${bounds.maxLon}`);
                }
            } catch (e) {
                logger.debug(`[GRIB2Parser] Could not parse grid bounds: ${e}`);
            }
        }

        // Build multiple -lon flags for point extraction
        // Convert to 0-360 longitude format as required by wgrib2
        const cityLonArgs: { index: number; lon: number; lat: number }[] = [];
        let skippedCities = 0;
        
        // Create a map from city name to original index for results mapping
        const cityIndexMap = new Map<string, number>();
        for (let i = 0; i < KNOWN_CITIES.length; i++) {
            cityIndexMap.set(KNOWN_CITIES[i].name, i);
        }
        
        for (const city of citiesToProcess) {
            // Convert to 0-360 format
            const lon360 = city.coordinates.lon < 0 ? city.coordinates.lon + 360 : city.coordinates.lon;
            
            // Check if city is within grid bounds (only for regional models)
            if (!isGlobalModel && bounds) {
                // Handle longitude wrapping for bounds check
                let inLonBounds = false;
                if (bounds.minLon <= bounds.maxLon) {
                    inLonBounds = lon360 >= bounds.minLon && lon360 <= bounds.maxLon;
                } else {
                    // Bounds wrap around 0/360
                    inLonBounds = lon360 >= bounds.minLon || lon360 <= bounds.maxLon;
                }
                
                const inLatBounds = city.coordinates.lat >= bounds.minLat && city.coordinates.lat <= bounds.maxLat;
                
                if (!inLatBounds || !inLonBounds) {
                    skippedCities++;
                    continue; // Skip cities outside domain
                }
            }
            
            const originalIndex = cityIndexMap.get(city.name);
            if (originalIndex !== undefined) {
                cityLonArgs.push({ index: originalIndex, lon: lon360, lat: city.coordinates.lat });
            }
        }
        
        if (skippedCities > 0 && logger.levels[logger.level] >= logger.levels.debug) {
            logger.debug(`[GRIB2Parser] Skipped ${skippedCities} cities outside grid domain, processing ${cityLonArgs.length} cities`);
        }
        
        if (cityLonArgs.length === 0) {
            logger.warn('[GRIB2Parser] No cities within grid domain');
            return [];
        }
        
        // Build args array properly - each -lon needs its own -lon flag and two coordinate values
        const wgrib2Path = this.getWgrib2Path();
        const args: string[] = [filePath, '-s', '-order', 'we:sn', '-match', matchers];
        
        // Add -lon flags properly: -lon lon lat (three separate array elements)
        for (const city of cityLonArgs) {
            args.push('-lon', city.lon.toString(), city.lat.toString());
        }

        if (logger.levels[logger.level] >= logger.levels.debug) {
            logger.debug(`[GRIB2Parser] Spawning ${wgrib2Path} with ${args.length} args`);
        }

        return new Promise((resolve, reject) => {
            const child = spawn(wgrib2Path, args);
            
            // Initialize per-city results
            const cityResults = new Array(KNOWN_CITIES.length);
            for (let i = 0; i < KNOWN_CITIES.length; i++) {
                cityResults[i] = { TMP: null, UGRD: null, VGRD: null, APCP: null };
            }
            
            const cityCount = KNOWN_CITIES.length;
            const cityLats = this.cityLats;
            const cityLons = this.cityLons;
            
            let buffer = '';
            let hasError = false;
            
            child.stdout.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                
                // Process complete lines
                let lineEnd = buffer.indexOf('\n');
                while (lineEnd !== -1) {
                    const line = buffer.substring(0, lineEnd).trim();
                    buffer = buffer.substring(lineEnd + 1);
                    
                    if (line) {
                        this.processWgrib2Line(line, cityResults, cityCount, cityLats, cityLons);
                    }
                    
                    lineEnd = buffer.indexOf('\n');
                }
            });
            
            let stderrBuffer = '';
            child.stderr.on('data', (chunk) => {
                stderrBuffer += chunk.toString();
            });
            
            child.on('error', (err) => {
                hasError = true;
                logger.error(`[GRIB2Parser] wgrib2 spawn error: ${err.message}`);
                reject(new Error(`Failed to spawn wgrib2: ${err.message}`));
            });
            
            child.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    logger.warn(`[GRIB2Parser] wgrib2 exited with code ${code}`);
                }

                // Log stderr if there's anything meaningful
                if (stderrBuffer.trim()) {
                    // Filter out common non-error messages
                    const filteredStderr = stderrBuffer
                        .split('\n')
                        .filter(line => 
                            line.trim() && 
                            !line.includes('warning') && 
                            !line.includes('Warning')
                        )
                        .join('\n');
                    
                    if (filteredStderr.trim()) {
                        logger.warn(`[GRIB2Parser] wgrib2 stderr: ${filteredStderr}`);
                    }
                }

                // Process any remaining buffer
                if (buffer.trim()) {
                     this.processWgrib2Line(buffer.trim(), cityResults, cityCount, cityLats, cityLons);
                }

                // Count results before converting (only log if debug enabled)
                if (logger.levels[logger.level] >= logger.levels.debug) {
                    const citiesWithTemp = cityResults.filter(r => r.TMP !== null).length;
                    logger.debug(`[GRIB2Parser] wgrib2 found ${citiesWithTemp}/${citiesToProcess.length} cities with temperature data`);
                }

                // Convert results to CityGRIBData
                const cityData: CityGRIBData[] = [];
                for (let i = 0; i < KNOWN_CITIES.length; i++) {
                    const city = KNOWN_CITIES[i];
                    const r = cityResults[i];

                    if (r.TMP === null) continue; // Need at least temperature

                    // Kelvin to Celsius conversion (wgrib2 outputs raw values)
                    const temperatureC = r.TMP - 273.15;

                    const windSpeedMps = (r.UGRD !== null && r.VGRD !== null)
                        ? Math.sqrt(r.UGRD * r.UGRD + r.VGRD * r.VGRD)
                        : 0;
                    const windDirection = (r.UGRD !== null && r.VGRD !== null)
                        ? (Math.atan2(r.VGRD, r.UGRD) * 180 / Math.PI + 360) % 360
                        : 0;

                    cityData.push({
                        cityName: city.name,
                        coordinates: city.coordinates,
                        temperatureC,
                        temperatureF: (temperatureC * 9 / 5) + 32,
                        windSpeedMps,
                        windSpeedMph: windSpeedMps * 2.23694,
                        windDirection,
                        totalPrecipitationMm: r.APCP ?? 0,
                        totalPrecipitationIn: (r.APCP ?? 0) / 25.4,
                        precipitationRateMmHr: r.APCP ?? 0,
                    });
                }

                if (!hasError) {
                    resolve(cityData);
                }
            });
        });
    }

    /**
     * Process a single line of wgrib2 output
     * Fixed: Now extracts ALL lon/lat/val triplets from batch output, not just the last one
     */
    private processWgrib2Line(
        line: string,
        cityResults: any[],
        cityCount: number,
        cityLats: Float64Array,
        cityLons: Float64Array
    ): void {
        // Fast variable check using unique substrings
        // Determine which variable this line belongs to
        let varName: string | null = null;
        // NCEP conventions
        if (line.includes(':TMP:2 m') || line.includes(':2t:2 m')) varName = 'TMP';
        else if (line.includes(':UGRD:10 m') || line.includes(':10u:10 m')) varName = 'UGRD';
        else if (line.includes(':VGRD:10 m') || line.includes(':10v:10 m')) varName = 'VGRD';
        else if (line.includes(':APCP:surf') || line.includes(':tp:surf') || line.includes(':TP:surf')) varName = 'APCP';
        
        if (!varName) return;

        // Fixed: Use regex to extract ALL lon/lat/val triplets (not just last one)
        // Batch mode outputs multiple cities on one line like:
        // "lon=286.0,lat=40.75,val=256.337:lon=279.0,lat=39.0,val=255.377:..."
        const regex = /lon=([\d.-]+),lat=([\d.-]+),val=([\d.-]+)/g;
        let match;
        
        while ((match = regex.exec(line)) !== null) {
            const outLon = parseFloat(match[1]);
            const outLat = parseFloat(match[2]);
            const val = parseFloat(match[3]);
            
            if (isNaN(val)) continue;

            // Find closest city (wgrib2 snaps to nearest grid point)
            // Use flat arrays for maximum speed (no object property access in loop)
            let bestCityIdx = -1;
            let bestDist = Infinity;
            
            for (let c = 0; c < cityCount; c++) {
                // Normalize lon to 0-360 for comparison (wgrib2 may output 0-360)
                let cityLon = cityLons[c];
                if (cityLon < 0) cityLon += 360;
                
                let compLon = outLon;
                if (compLon < 0) compLon += 360;
                
                const dLon = compLon - cityLon;
                const dLat = outLat - cityLats[c];
                
                const dist = dLon * dLon + dLat * dLat;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestCityIdx = c;
                }
            }

            if (bestCityIdx >= 0 && bestDist < 16.0) { // Within ~4 degrees tolerance
                const cr = cityResults[bestCityIdx];
                if (varName === 'TMP') cr.TMP = val;
                else if (varName === 'UGRD') cr.UGRD = val;
                else if (varName === 'VGRD') cr.VGRD = val;
                else if (varName === 'APCP') cr.APCP = val;
            }
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
    private async parseWithEcCodes(filePath: string, options: ParseOptions, citiesToProcess: typeof KNOWN_CITIES): Promise<CityGRIBData[]> {
        logger.info('[GRIB2Parser] Using ecCodes (grib_get) for parsing');

        // Run all 4 variable extractions in parallel; each internally spawns per-city calls
        const shortNames = ['2t', '10u', '10v', 'tp'] as const;
        const factories = shortNames.map(sn => () => this.runGribGetAllCities(filePath, sn, citiesToProcess));
        const [tempResults, uWindResults, vWindResults, precipResults] =
            await this.runWithConcurrencyLimit(factories, 4);

        // Log extraction results for debugging
        const tempCount = tempResults.filter(v => v !== null).length;
        const windCount = uWindResults.filter(v => v !== null).length;
        logger.info(`[GRIB2Parser] ecCodes extraction: ${tempCount}/${citiesToProcess.length} cities got temperature, ${windCount} got wind`);

        // Build city data from combined results
        const cityData: CityGRIBData[] = [];
        for (let i = 0; i < citiesToProcess.length; i++) {
            const city = citiesToProcess[i];
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
        shortName: string,
        citiesToProcess: typeof KNOWN_CITIES
    ): Promise<(number | null)[]> {
        const factories = citiesToProcess.map((city) => () => {
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

        // Run all cities in parallel
        return this.runWithConcurrencyLimit(factories, citiesToProcess.length);
    }

    /**
     * Check if wgrib2 is available and resolve its path
     * Note: wgrib2 -version returns exit code 8, so we check if it runs at all
     */
    private checkWgrib2Available(): boolean {
        // Build list of paths to try - config takes priority
        const commonPaths: string[] = [];
        
        // First, check if a custom path is configured via environment variable
        if (config.WGRIB2_PATH) {
            commonPaths.push(config.WGRIB2_PATH);
        }
        
        // Then try standard locations (bot may not have /usr/local/bin in PATH)
        commonPaths.push(
            '/usr/local/bin/wgrib2',
            '/usr/bin/wgrib2',
            'wgrib2' // fallback to PATH
        );

        for (const cmd of commonPaths) {
            try {
                execSync(`${cmd} -version`, { stdio: 'pipe' });
                WGRIB2_PATH = cmd;
                logger.info(`[GRIB2Parser] Found wgrib2 at: ${cmd}`);
                return true;
            } catch (error: any) {
                // wgrib2 returns exit code 8 for -version but still works fine
                // Check if error has stdout (meaning wgrib2 ran but returned non-zero)
                const stdout = error.stdout?.toString() || '';
                const stderr = error.stderr?.toString() || '';
                const output = stdout + stderr;
                
                if (output.includes('v3.') || output.includes('v2.') || output.includes('wgrib2')) {
                    WGRIB2_PATH = cmd;
                    logger.info(`[GRIB2Parser] Found wgrib2 at: ${cmd}`);
                    return true;
                }
                // Command not found, try next path
                continue;
            }
        }

        logger.warn('[GRIB2Parser] wgrib2 not found in any standard location, falling back to ecCodes');
        return false;
    }

    /**
     * Get the resolved wgrib2 path
     */
    private getWgrib2Path(): string {
        return WGRIB2_PATH || 'wgrib2';
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
