/**
 * Tomorrow.io Webhook Handler
 * Handles incoming webhooks from Tomorrow.io and triggers forecast fetching
 */

import { Router, Request, Response } from 'express';
import { webhookValidator, getWebhookPayload, TomorrowWebhookPayload } from './middleware/webhook-validator.js';
import { eventBus } from '../realtime/event-bus.js';
import { findCity, Coordinates, KNOWN_CITIES } from '../weather/types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Idempotency key store
 * Uses in-memory map with TTL to prevent duplicate webhook processing
 */
class IdempotencyStore {
    private processedIds: Map<string, number> = new Map();
    private readonly ttlMs: number = 60 * 60 * 1000; // 1 hour TTL

    /**
     * Check if a webhook ID has been processed
     */
    hasProcessed(forecastId: string, timestamp: string): boolean {
        const key = this.generateKey(forecastId, timestamp);
        const expiry = this.processedIds.get(key);

        if (expiry && Date.now() < expiry) {
            return true;
        }

        // Clean up expired entry if exists
        if (expiry) {
            this.processedIds.delete(key);
        }

        return false;
    }

    /**
     * Mark a webhook ID as processed
     */
    markProcessed(forecastId: string, timestamp: string): void {
        const key = this.generateKey(forecastId, timestamp);
        this.processedIds.set(key, Date.now() + this.ttlMs);

        // Periodic cleanup of old entries
        if (this.processedIds.size % 100 === 0) {
            this.cleanup();
        }
    }

    /**
     * Generate unique key from forecast ID and timestamp
     */
    private generateKey(forecastId: string, timestamp: string): string {
        return `${forecastId}:${timestamp}`;
    }

    /**
     * Clean up expired entries
     */
    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, expiry] of this.processedIds.entries()) {
            if (now > expiry) {
                this.processedIds.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger.debug(`Idempotency store cleanup: removed ${cleaned} expired entries`);
        }
    }
}

// Singleton idempotency store
const idempotencyStore = new IdempotencyStore();

/**
 * Normalize location to city_id using existing city mappings
 */
function normalizeLocation(location: TomorrowWebhookPayload['location']): { cityId: string; coordinates: Coordinates } {
    const coordinates = {
        lat: location.lat,
        lon: location.lon,
    };

    // If city name is provided, try to find it in known cities
    if (location.city) {
        const city = findCity(location.city);
        if (city) {
            return { cityId: city.name.toLowerCase().replace(/\s+/g, '_'), coordinates: city.coordinates };
        }
    }

    // Try to find city by coordinates (approximate match)
    // This is a simple implementation - in production, you might want a more sophisticated
    // spatial index or reverse geocoding
    const KNOWN_CITY_RADIUS_KM = 25; // Consider cities within 25km

    // Check distance to known cities
    for (const city of KNOWN_CITIES) {
        const distance = calculateDistance(coordinates, city.coordinates);
        if (distance <= KNOWN_CITY_RADIUS_KM) {
            return { cityId: city.name.toLowerCase().replace(/\s+/g, '_'), coordinates: city.coordinates };
        }
    }

    // If no city match, return coordinates-based ID
    return {
        cityId: `lat${location.lat.toFixed(2)}_lon${location.lon.toFixed(2)}`,
        coordinates,
    };
}

/**
 * Calculate distance between two coordinates in kilometers
 * Uses Haversine formula
 */
function calculateDistance(a: Coordinates, b: Coordinates): number {
    const R = 6371; // Earth's radius in km
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);

    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);

    const c = 2 * Math.atan2(
        Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon),
        Math.sqrt(1 - (sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon))
    );

    return R * c;
}

function toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
}

/**
 * Handle incoming Tomorrow.io webhook
 */
async function handleWebhook(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
        // Get validated payload from middleware
        const payload = getWebhookPayload(req);
        if (!payload) {
            // This shouldn't happen if middleware is working correctly
            logger.error('Webhook handler called without validated payload');
            res.status(500).json({ error: 'Internal server error' });
            return;
        }

        // Idempotency check
        if (idempotencyStore.hasProcessed(payload.data.forecastId, payload.timestamp)) {
            logger.debug('Duplicate webhook received, returning 200', {
                forecastId: payload.data.forecastId,
                timestamp: payload.timestamp,
            });
            res.status(200).json({ status: 'duplicate', message: 'Already processed' });
            return;
        }

        // Mark as processed immediately to prevent race conditions
        idempotencyStore.markProcessed(payload.data.forecastId, payload.timestamp);

        // Normalize location to city_id
        const { cityId, coordinates } = normalizeLocation(payload.location);

        logger.info('🌤️ Tomorrow.io webhook received', {
            event: payload.event,
            cityId,
            updateType: payload.data.updateType,
            forecastId: payload.data.forecastId,
        });

        // Record webhook statistics
        eventBus.recordWebhookReceived();

        // Emit FORECAST_TRIGGER event via event bus
        // This is non-blocking - we return 200 immediately
        eventBus.emit({
            type: 'FORECAST_TRIGGER',
            payload: {
                provider: 'tomorrow.io',
                cityId,
                triggerTimestamp: new Date(),
                location: coordinates,
                forecastId: payload.data.forecastId,
                updateType: payload.data.updateType,
            },
        });

        // Record trigger and processed statistics
        eventBus.recordTrigger();
        eventBus.recordWebhookProcessed();

        // Return 200 immediately after validation
        // The actual processing happens asynchronously via event bus
        const processingTime = Date.now() - startTime;
        res.status(200).json({
            status: 'accepted',
            cityId,
            processingTimeMs: processingTime,
        });

        logger.debug('Webhook processed successfully', {
            cityId,
            processingTimeMs: processingTime,
        });
    } catch (error) {
        // Log error but still return 200 to prevent Tomorrow.io from retrying
        // (we don't want to be rate limited by their retry logic)
        logger.error('Error processing webhook', {
            error: (error as Error).message,
            stack: (error as Error).stack,
        });

        // Return 200 even on error to acknowledge receipt
        // The error is logged and can be monitored
        res.status(200).json({
            status: 'error_logged',
            message: 'Error logged, do not retry',
        });
    }
}

/**
 * Health check endpoint for webhook status
 */
function handleHealthCheck(req: Request, res: Response): void {
    res.json({
        status: 'healthy',
        webhookMode: config.USE_WEBHOOK_MODE,
        webhookSecretConfigured: !!config.TOMORROW_WEBHOOK_SECRET,
    });
}

/**
 * Create and configure the webhook router
 */
export function createWebhookRouter(): Router {
    const router = Router();

    // Health check endpoint (no validation required)
    router.get('/health', handleHealthCheck);

    // Main webhook endpoint with validation middleware
    router.post('/', webhookValidator, handleWebhook);

    return router;
}

// Export for testing
export { idempotencyStore, normalizeLocation };
