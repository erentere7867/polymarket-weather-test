/**
 * S3 File Detector
 * Uses AWS SDK to poll NOAA S3 buckets using HeadObject for fast existence checks
 */

import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import { S3Client, HeadObjectCommand, GetObjectCommand, HeadObjectOutput } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
    ModelType,
    ExpectedFileInfo,
    ModelRunSchedule,
    FileDetectionResult,
    ParsedGRIBData,
    DetectionWindow,
} from './types.js';
import { EventBus } from '../realtime/event-bus.js';
import { GRIB2Parser } from './grib2-parser.js';
import { logger } from '../logger.js';

/**
 * S3 File Detector Configuration
 */
export interface S3DetectorConfig {
    /** Poll interval in milliseconds (100-250ms recommended) */
    pollIntervalMs: number;
    /** Maximum duration to poll for a file (milliseconds) */
    maxDetectionDurationMs: number;
    /** Timeout for file download (milliseconds) */
    downloadTimeoutMs: number;
    /** AWS region for S3 */
    region: string;
    /** Whether S3 buckets are public (no auth required) */
    publicBuckets: boolean;
}

/**
 * Detection context for active polling
 */
interface DetectionContext {
    expectedFile: ExpectedFileInfo;
    schedule: ModelRunSchedule;
    windowStart: Date;
    pollTimer: NodeJS.Timeout | null;
    isDetecting: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: S3DetectorConfig = {
    pollIntervalMs: 150,           // 150ms between HeadObject checks
    maxDetectionDurationMs: 45 * 60 * 1000,  // 45 minutes max
    downloadTimeoutMs: 30 * 1000,  // 30 seconds download timeout
    region: 'us-east-1',
    publicBuckets: true,
};

/**
 * S3 File Detector
 * Polls NOAA S3 buckets using HeadObject for existence checks
 */
export class S3FileDetector extends EventEmitter {
    private s3Client: S3Client;
    private config: S3DetectorConfig;
    private eventBus: EventBus;
    private gribParser: GRIB2Parser;
    private activeDetections: Map<string, DetectionContext> = new Map();
    private regionClients: Map<string, S3Client> = new Map();

    constructor(config: Partial<S3DetectorConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = EventBus.getInstance();
        
        // Initialize default S3 client
        this.s3Client = this.createClient(this.config.region);
        
        this.gribParser = new GRIB2Parser();
    }

    /**
     * Create an S3 client for a specific region
     */
    private createClient(region: string): S3Client {
        // Configure HTTP keep-alive and connection pooling for lower latency
        const requestHandler = new NodeHttpHandler({
            httpAgent: new http.Agent({
                keepAlive: true,
                maxSockets: 25,
                keepAliveMsecs: 30000,
            }),
            httpsAgent: new https.Agent({
                keepAlive: true,
                maxSockets: 25,
                keepAliveMsecs: 30000,
            }),
            connectionTimeout: 5000,
            socketTimeout: 30000,
        });

        return new S3Client({
            region: region,
            requestHandler,
            // For public buckets, we use no credentials and a void signer
            // to prevent the SDK from trying to sign requests or look for creds
            ...(this.config.publicBuckets && {
                credentials: {
                    accessKeyId: '', // Empty strings satisfy the provider
                    secretAccessKey: '',
                },
                signer: { sign: async (request) => request }, // Bypass signing
            }),
        });
    }

    /**
     * Get S3 client for a specific region
     */
    private getClient(region?: string): S3Client {
        if (!region || region === this.config.region) {
            return this.s3Client;
        }

        if (!this.regionClients.has(region)) {
            logger.info(`[S3FileDetector] Creating new S3 client for region: ${region}`);
            this.regionClients.set(region, this.createClient(region));
        }

        return this.regionClients.get(region)!;
    }

    /**
     * Start detecting a specific file
     * Returns immediately, emits events when file is detected
     */
    public startDetection(expectedFile: ExpectedFileInfo, schedule: ModelRunSchedule): void {
        const key = this.getDetectionKey(expectedFile);
        
        if (this.activeDetections.has(key)) {
            logger.warn(`[S3FileDetector] Detection already active for ${key}`);
            return;
        }
        
        const windowStart = new Date();
        
        const context: DetectionContext = {
            expectedFile,
            schedule,
            windowStart,
            pollTimer: null,
            isDetecting: true,
        };
        
        this.activeDetections.set(key, context);
        
        logger.info(
            `[S3FileDetector] Starting detection for ${expectedFile.model} ${String(expectedFile.cycleHour).padStart(2, '0')}Z: ${expectedFile.key}`
        );
        
        // Start polling immediately
        this.pollForFile(key);
    }

    /**
     * Stop detecting a specific file
     */
    public stopDetection(fileKey: string): void {
        const context = this.activeDetections.get(fileKey);
        if (context) {
            context.isDetecting = false;
            if (context.pollTimer) {
                clearTimeout(context.pollTimer);
            }
            this.activeDetections.delete(fileKey);
            logger.info(`[S3FileDetector] Stopped detection for ${fileKey}`);
        }
    }

    /**
     * Stop all active detections
     */
    public stopAll(): void {
        logger.info(`[S3FileDetector] Stopping all ${this.activeDetections.size} active detections`);
        for (const key of this.activeDetections.keys()) {
            this.stopDetection(key);
        }
    }

    /**
     * Get number of active detections
     */
    public getActiveDetectionCount(): number {
        return this.activeDetections.size;
    }

    /**
     * Poll S3 for file existence using HeadObject
     */
    private async pollForFile(key: string): Promise<void> {
        const context = this.activeDetections.get(key);
        if (!context || !context.isDetecting) {
            return;
        }
        
        const { expectedFile, windowStart } = context;
        const { bucket, key: s3Key } = expectedFile;
        
        const elapsedMs = Date.now() - windowStart.getTime();
        // Throttle polling logs to every 30 seconds to reduce overhead
        if (elapsedMs % 30000 < 200) {
            logger.info(`[S3FileDetector] Polling ${expectedFile.model} ${String(expectedFile.cycleHour).padStart(2, '0')}Z: ${s3Key} (${Math.round(elapsedMs/1000)}s elapsed)`);
        }
        
        try {
            // Check if file exists using HeadObject
            const headResult = await this.pollHeadObject(bucket, s3Key, expectedFile.region);
            
            if (headResult) {
                // File detected! (HEAD success logged below with full detection info)
                const detectedAt = new Date();
                const detectionLatencyMs = detectedAt.getTime() - windowStart.getTime();
                
                const result: FileDetectionResult = {
                    expectedFile,
                    detectedAt,
                    detectionLatencyMs,
                    downloadUrl: expectedFile.fullUrl,
                    fileSize: headResult.ContentLength || 0,
                    lastModified: headResult.LastModified || detectedAt,
                };
                
                logger.info(
                    `[S3FileDetector] File detected: ${s3Key} (${detectionLatencyMs}ms latency, ${result.fileSize} bytes)`
                );
                
                // Stop polling
                this.stopDetection(key);
                
                // Emit FILE_DETECTED event
                this.eventBus.emit({
                    type: 'FILE_DETECTED',
                    payload: {
                        model: expectedFile.model,
                        cycleHour: expectedFile.cycleHour,
                        forecastHour: expectedFile.forecastHour,
                        bucket,
                        key: s3Key,
                        detectedAt,
                        detectionLatencyMs,
                        fileSize: result.fileSize,
                        lastModified: result.lastModified,
                    },
                });
                
                this.emit('detected', result);
                
                // Download and parse immediately
                await this.downloadAndParse(result);
                
                return;
            }
        } catch (error) {
            logger.error(`[S3FileDetector] Error polling ${s3Key}:`, error);
        }
        
        // Check if we've exceeded max detection duration
        if (elapsedMs > this.config.maxDetectionDurationMs) {
            logger.warn(`[S3FileDetector] Detection timeout for ${s3Key}`);
            this.stopDetection(key);
            this.emit('timeout', { expectedFile });
            return;
        }
        
        // Schedule next poll
        if (context.isDetecting) {
            context.pollTimer = setTimeout(() => {
                this.pollForFile(key);
            }, this.config.pollIntervalMs);
        }
    }

    /**
     * Poll S3 with HeadObject (fast existence check)
     */
    private async pollHeadObject(bucket: string, key: string, region?: string): Promise<HeadObjectOutput | null> {
        // Note: Per-request logging moved to debug level to reduce overhead (~400 requests/min)
        logger.debug(`[S3FileDetector] HEAD Request - Bucket: ${bucket}, Key: ${key}`);

        try {
            const command = new HeadObjectCommand({
                Bucket: bucket,
                Key: key,
            });
            
            const client = this.getClient(region);
            const response = await client.send(command);
            return response;
        } catch (error: any) {
            // 404 or NoSuchKey means file doesn't exist yet
            if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
                return null;
            }
            // For public buckets, we might get 403 instead of 404
            if (error.$metadata?.httpStatusCode === 404 || error.$metadata?.httpStatusCode === 403) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Download specific ranges based on .idx file
     * Returns concatenated buffer of relevant data or null if failed/skipped
     */
    private async downloadWithSmartFetch(
        bucket: string,
        key: string,
        region: string | undefined,
        totalFileSize: number
    ): Promise<Buffer | null> {
        try {
            const idxKey = key + '.idx';
            logger.info(`[S3FileDetector] Attempting Smart Download with index: ${idxKey}`);

            // 1. Download .idx file
            logger.info(`[S3FileDetector] Fetching .idx file: ${idxKey}`);
            const idxStart = Date.now();
            
            let idxResponse;
            const client = this.getClient(region);

            // Retry logic for .idx file (up to 3 times, 150ms delay)
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const command = new GetObjectCommand({
                        Bucket: bucket,
                        Key: idxKey,
                    });
                    idxResponse = await client.send(command);
                    logger.info(`[S3FileDetector] .idx fetch took ${Date.now() - idxStart}ms`);
                    break;
                } catch (e: any) {
                    // If .idx doesn't exist, retry if we have attempts left
                    if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
                        if (attempt < 3) {
                            logger.warn(`[S3FileDetector] .idx not found (attempt ${attempt}/3), retrying in 150ms...`);
                            await new Promise(resolve => setTimeout(resolve, 150));
                            continue;
                        }
                        logger.info(`[S3FileDetector] .idx file not found for ${key}, falling back to full download (Check took ${Date.now() - idxStart}ms)`);
                        return null;
                    }
                    logger.error(`[S3FileDetector] Error fetching .idx: ${e.message}`);
                    throw e;
                }
            }
            
            if (!idxResponse || !idxResponse.Body) return null;
            
            // Read .idx content
            const chunks: Buffer[] = [];
            for await (const chunk of idxResponse.Body as any) {
                chunks.push(chunk);
            }
            const idxContent = Buffer.concat(chunks).toString('utf-8');

            // 2. Parse index and find ranges
            const lines = idxContent.split('\n').filter(l => l.trim().length > 0);
            logger.debug(`[S3FileDetector] Parsing ${lines.length} lines from .idx`);
            const ranges: { start: number; end: number }[] = [];
            
            // Variables we care about
            const patterns = [
                ':TMP:2 m above ground:',
                ':PRATE:',
                ':UGRD:10 m above ground:',
                ':VGRD:10 m above ground:',
                ':APCP:'
            ];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Check if line contains any of our target variables
                let matches = false;
                for (const p of patterns) {
                    if (line.includes(p)) {
                        matches = true;
                        break;
                    }
                }

                if (matches) {
                     // Extract start byte
                     // Format: num:byte:date:var:level:forecast:
                     const parts = line.split(':');
                     if (parts.length < 3) continue;
                     
                     const start = parseInt(parts[1], 10);
                     if (isNaN(start)) continue;
                     
                     // Find end byte (start of next message - 1)
                     let end = totalFileSize - 1;
                     
                     // Look ahead for the next valid line to determine end
                     if (i + 1 < lines.length) {
                         const nextLine = lines[i+1];
                         const nextParts = nextLine.split(':');
                         if (nextParts.length >= 2) {
                             const nextStart = parseInt(nextParts[1], 10);
                             if (!isNaN(nextStart)) {
                                 end = nextStart - 1;
                             }
                         }
                     }
                     
                     ranges.push({ start, end });
                }
            }

            if (ranges.length === 0) {
                logger.warn(`[S3FileDetector] No matching variables found in .idx for ${key}`);
                return null;
            }

            logger.info(`[S3FileDetector] Smart Download identified ${ranges.length} ranges to fetch`);

            // 3. Download ranges in parallel
            const chunkPromises = ranges.map(async (range) => {
                 const rangeCmd = new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Range: `bytes=${range.start}-${range.end}`
                });
                const rangeResp = await client.send(rangeCmd);
                
                const rangeChunks: Buffer[] = [];
                if (rangeResp.Body) {
                    for await (const chunk of rangeResp.Body as any) {
                         rangeChunks.push(chunk);
                    }
                }
                return Buffer.concat(rangeChunks);
            });

            const downloadedChunks = await Promise.all(chunkPromises);
            
            // 4. Concatenate all chunks
            return Buffer.concat(downloadedChunks);

        } catch (error) {
            logger.warn(`[S3FileDetector] Smart Download failed (falling back): ${error}`);
            return null;
        }
    }

    /**
     * Download and parse a detected file
     */
    private async downloadAndParse(result: FileDetectionResult): Promise<void> {
        const { expectedFile, detectedAt } = result;
        const downloadStart = Date.now();
        
        logger.info(`[S3FileDetector] Downloading ${expectedFile.key}...`);
        
        try {
            let buffer: Buffer | null = null;
            let downloadMethod = "Full Download";

            // 1. Try Smart Download first
            buffer = await this.downloadWithSmartFetch(
                expectedFile.bucket,
                expectedFile.key,
                expectedFile.region,
                result.fileSize
            );

            if (buffer) {
                downloadMethod = "Smart Download";
            } else {
                // 2. Fallback to Full Download
                const command = new GetObjectCommand({
                    Bucket: expectedFile.bucket,
                    Key: expectedFile.key,
                });
                
                const client = this.getClient(expectedFile.region);
                const response = await client.send(command);
                
                if (!response.Body) {
                    throw new Error('Empty response body');
                }
                
                // Pre-allocate buffer if Content-Length is available
                const contentLength = response.ContentLength;
                
                if (contentLength && contentLength > 0 && contentLength < 100 * 1024 * 1024) {
                    // Pre-allocate buffer for known size (under 100MB safety limit)
                    buffer = Buffer.allocUnsafe(contentLength);
                    let offset = 0;
                    for await (const chunk of response.Body as any) {
                        offset += chunk.copy(buffer, offset);
                    }
                } else {
                    // Fallback to dynamic allocation for unknown size
                    const chunks: Buffer[] = [];
                    for await (const chunk of response.Body as any) {
                        chunks.push(chunk);
                    }
                    buffer = Buffer.concat(chunks);
                }
            }
            
            const downloadTimeMs = Date.now() - downloadStart;
            
            logger.info(
                `[S3FileDetector] ${downloadMethod} completed for ${expectedFile.key} (${buffer.length} bytes in ${downloadTimeMs}ms)`
            );
            
            // Parse the GRIB2 file
            const parseStart = Date.now();
            const parsedData = await this.gribParser.parse(buffer, {
                model: expectedFile.model,
                cycleHour: expectedFile.cycleHour,
                forecastHour: expectedFile.forecastHour,
            });
            
            const parseTimeMs = Date.now() - parseStart;
            const totalLatencyMs = Date.now() - detectedAt.getTime();
            
            logger.info(
                `[S3FileDetector] Parsed ${expectedFile.key} in ${parseTimeMs}ms (total latency: ${totalLatencyMs}ms)`
            );
            
            // Emit local confirmed event
            this.emit('confirmed', {
                result,
                data: parsedData,
                downloadTimeMs,
                parseTimeMs,
            });
            
        } catch (error) {
            logger.error(`[S3FileDetector] Error downloading/parsing ${expectedFile.key}:`, error);
            this.emit('error', { expectedFile, error });
        }
    }

    /**
     * Pre-warm S3 clients by making a lightweight request
     * Eliminates cold-start latency (DNS, TLS handshake) on first real detection
     */
    public async warmup(): Promise<void> {
        const warmupStart = Date.now();
        logger.info('[S3FileDetector] Pre-warming S3 clients...');

        // Warm up default client with a HEAD to a known old file
        try {
            await this.s3Client.send(new HeadObjectCommand({
                Bucket: 'noaa-hrrr-bdp-pds',
                Key: 'hrrr.20200101/conus/hrrr.t00z.wrfsfcf00.grib2',
            }));
        } catch {
            // Expected to fail (404/403) - that's fine, we just want the connection warmed
        }

        // Warm up any pre-created regional clients
        for (const [region, client] of this.regionClients) {
            try {
                await client.send(new HeadObjectCommand({
                    Bucket: 'noaa-gfs-bdp-pds',
                    Key: 'gfs.20200101/00/atmos/gfs.t00z.pgrb2.0p25.f003',
                }));
            } catch {
                // Expected to fail - connection warmup only
            }
        }

        logger.info(`[S3FileDetector] S3 clients pre-warmed in ${Date.now() - warmupStart}ms`);
    }

    /**
     * Generate unique key for detection context
     */
    private getDetectionKey(expectedFile: ExpectedFileInfo): string {
        return `${expectedFile.model}-${expectedFile.cycleHour}-${expectedFile.forecastHour}`;
    }
}

export default S3FileDetector;