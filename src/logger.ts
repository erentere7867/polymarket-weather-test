import winston from 'winston';
import { config } from './config.js';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine log level based on environment
// Default to 'warn' in production, 'info' if SIMULATION_MODE=true
function getLogLevel(): string {
    const envLevel = config.logLevel;
    if (envLevel) return envLevel;
    return config.simulationMode ? 'info' : 'warn';
}

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
});

export const logger = winston.createLogger({
    level: getLogLevel(),
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console({
            format: combine(
                colorize(),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                logFormat
            ),
        }),
        // File rotation: 10MB per file, keep 5 files max
        new DailyRotateFile({
            filename: path.join(__dirname, '../logs/combined-YYYY-MM-DD.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '10m',
            maxFiles: '5',
            level: getLogLevel(),
        }),
        // Separate error log
        new DailyRotateFile({
            filename: path.join(__dirname, '../logs/error-YYYY-MM-DD.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '10m',
            maxFiles: '5',
            level: 'error',
        }),
    ],
});

/**
 * Rate-limited logger wrapper to prevent log spam
 * Production-ready logging with automatic throttling
 */
export class RateLimitedLogger {
    private lastLogTime: Map<string, number> = new Map();
    private logCounts: Map<string, number> = new Map();
    private readonly minIntervalMs: number;
    private readonly burstLimit: number;

    constructor(minIntervalMs: number = 60000, burstLimit: number = 5) {
        this.minIntervalMs = minIntervalMs;
        this.burstLimit = burstLimit;
    }

    /**
     * Log a message with rate limiting per key
     */
    log(key: string, level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, unknown>): void {
        const now = Date.now();
        const lastTime = this.lastLogTime.get(key) || 0;
        const count = (this.logCounts.get(key) || 0) + 1;
        
        this.logCounts.set(key, count);

        const shouldLog = 
            count <= this.burstLimit || // Allow burst
            (now - lastTime) >= this.minIntervalMs; // Or interval passed

        if (shouldLog) {
            if (count > this.burstLimit) {
                message = `${message} (repeated ${count} times)`;
                this.logCounts.set(key, 0);
            }
            this.lastLogTime.set(key, now);
            logger.log(level, message, meta);
        }
    }

    info(key: string, message: string, meta?: Record<string, unknown>): void {
        this.log(key, 'info', message, meta);
    }

    warn(key: string, message: string, meta?: Record<string, unknown>): void {
        this.log(key, 'warn', message, meta);
    }

    error(key: string, message: string, meta?: Record<string, unknown>): void {
        this.log(key, 'error', message, meta);
    }

    debug(key: string, message: string, meta?: Record<string, unknown>): void {
        this.log(key, 'debug', message, meta);
    }
}

/**
 * Global rate-limited logger instance (5 min default interval)
 */
export const rateLimitedLogger = new RateLimitedLogger(300000, 3);
