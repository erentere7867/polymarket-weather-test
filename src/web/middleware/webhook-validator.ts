/**
 * Webhook Validator Middleware
 * Validates Tomorrow.io webhook signatures using HMAC-SHA256
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * Tomorrow.io webhook payload structure
 */
export interface TomorrowWebhookPayload {
    event: 'forecast.update' | 'forecast.alert';
    timestamp: string; // ISO 8601
    location: {
        lat: number;
        lon: number;
        city?: string;
    };
    data: {
        forecastId: string;
        updateType: 'temperature' | 'precipitation' | 'snow';
        severity?: 'low' | 'medium' | 'high';
    };
}

/**
 * Validation result
 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
    payload?: TomorrowWebhookPayload;
}

/**
 * Extract signature from request headers
 * Tomorrow.io uses X-Signature or X-Tomorrow-Signature header
 */
function extractSignature(req: Request): string | null {
    // Check common signature header names
    const signature =
        (req.headers['x-signature'] as string) ||
        (req.headers['x-tomorrow-signature'] as string) ||
        (req.headers['x-webhook-signature'] as string);

    return signature || null;
}

/**
 * Compute HMAC-SHA256 signature for the payload
 */
function computeSignature(payload: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('hex');
}

/**
 * Verify webhook signature
 */
function verifySignature(payload: string, signature: string, secret: string): boolean {
    const computed = computeSignature(payload, secret);

    // Use timing-safe comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(computed, 'hex'),
            Buffer.from(signature, 'hex')
        );
    } catch {
        // Buffer lengths don't match
        return false;
    }
}

/**
 * Validate webhook payload structure
 */
function validatePayload(body: unknown): ValidationResult {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Invalid payload: expected object' };
    }

    const payload = body as Partial<TomorrowWebhookPayload>;

    // Check required fields
    if (!payload.event) {
        return { valid: false, error: 'Missing required field: event' };
    }

    if (!payload.timestamp) {
        return { valid: false, error: 'Missing required field: timestamp' };
    }

    if (!payload.location || typeof payload.location !== 'object') {
        return { valid: false, error: 'Missing required field: location' };
    }

    if (typeof payload.location.lat !== 'number' || typeof payload.location.lon !== 'number') {
        return { valid: false, error: 'Invalid location: lat and lon must be numbers' };
    }

    if (!payload.data || typeof payload.data !== 'object') {
        return { valid: false, error: 'Missing required field: data' };
    }

    if (!payload.data.forecastId) {
        return { valid: false, error: 'Missing required field: data.forecastId' };
    }

    // Validate event type
    const validEvents = ['forecast.update', 'forecast.alert'];
    if (!validEvents.includes(payload.event)) {
        return { valid: false, error: `Invalid event type: ${payload.event}` };
    }

    // Validate timestamp format
    const timestamp = new Date(payload.timestamp);
    if (isNaN(timestamp.getTime())) {
        return { valid: false, error: 'Invalid timestamp format' };
    }

    // Check if timestamp is within reasonable range (not too old, not in future)
    const now = Date.now();
    const eventTime = timestamp.getTime();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const oneMinuteFromNow = now + 60 * 1000;

    if (eventTime < fiveMinutesAgo) {
        return { valid: false, error: 'Timestamp too old (> 5 minutes)' };
    }

    if (eventTime > oneMinuteFromNow) {
        return { valid: false, error: 'Timestamp in the future' };
    }

    return { valid: true, payload: payload as TomorrowWebhookPayload };
}

/**
 * Express middleware to validate Tomorrow.io webhooks
 */
export function webhookValidator(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    // Skip validation if webhook mode is disabled or secret not configured
    if (!config.USE_WEBHOOK_MODE) {
        logger.debug('Webhook validation skipped: webhook mode disabled');
        next();
        return;
    }

    const secret = config.TOMORROW_WEBHOOK_SECRET;
    if (!secret) {
        logger.warn('Webhook validation skipped: TOMORROW_WEBHOOK_SECRET not configured');
        // In development, allow through but log warning
        if (config.simulationMode) {
            next();
            return;
        }
        res.status(401).json({ error: 'Webhook secret not configured' });
        return;
    }

    // Extract signature from headers
    const signature = extractSignature(req);
    if (!signature) {
        logger.warn('Webhook validation failed: missing signature header');
        res.status(401).json({ error: 'Missing signature header' });
        return;
    }

    // Get raw body for signature verification
    // Note: This requires express.raw() or express.json() middleware to be configured
    // to preserve the raw body for signature verification
    const rawBody = req.body;
    let payloadString: string;

    if (typeof rawBody === 'string') {
        payloadString = rawBody;
    } else if (Buffer.isBuffer(rawBody)) {
        payloadString = rawBody.toString('utf8');
    } else if (typeof rawBody === 'object') {
        // Re-serialize for signature verification (order matters for HMAC)
        payloadString = JSON.stringify(rawBody);
    } else {
        logger.warn('Webhook validation failed: invalid body type');
        res.status(400).json({ error: 'Invalid request body' });
        return;
    }

    // Verify signature
    if (!verifySignature(payloadString, signature, secret)) {
        logger.warn('Webhook validation failed: invalid signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
    }

    // Validate payload structure
    const validation = validatePayload(req.body);
    if (!validation.valid) {
        logger.warn('Webhook validation failed: invalid payload', { error: validation.error });
        res.status(400).json({ error: validation.error });
        return;
    }

    // Attach validated payload to request for downstream handlers
    (req as any).webhookPayload = validation.payload;

    logger.debug('Webhook signature validated successfully');
    next();
}

/**
 * Express middleware to capture raw body for signature verification
 * Must be used BEFORE express.json() middleware
 */
export function captureRawBody(
    req: Request,
    res: Response,
    buf: Buffer,
    encoding: BufferEncoding
): void {
    (req as any).rawBody = buf.toString(encoding || 'utf8');
}

/**
 * Get validated webhook payload from request
 */
export function getWebhookPayload(req: Request): TomorrowWebhookPayload | undefined {
    return (req as any).webhookPayload;
}
