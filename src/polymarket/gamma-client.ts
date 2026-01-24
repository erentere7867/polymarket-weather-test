/**
 * Polymarket Gamma API Client
 * Used for market discovery and metadata
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { PolymarketEvent, PolymarketMarket } from './types.js';

interface GammaEventsResponse extends Array<{
    id: string;
    slug: string;
    title: string;
    description?: string;
    active: boolean;
    closed: boolean;
    startDate?: string;
    endDate?: string;
    tags?: Array<{ id: string; label: string; slug: string }>;
    markets: Array<{
        id: string;
        conditionId: string;
        slug: string;
        question: string;
        description?: string;
        outcomes: string;
        outcomePrices: string;
        clobTokenIds: string;
        active: boolean;
        closed: boolean;
        endDateIso?: string;
        volume?: string;
        liquidity?: string;
        tags?: Array<{ id: string; label: string; slug: string }>;
    }>;
}> { }

interface GammaMarketsResponse extends Array<{
    id: string;
    conditionId: string;
    slug: string;
    question: string;
    description?: string;
    outcomes: string;
    outcomePrices: string;
    clobTokenIds: string;
    active: boolean;
    closed: boolean;
    endDateIso?: string;
    volume?: string;
    liquidity?: string;
    tags?: Array<{ id: string; label: string; slug: string }>;
}> { }

export class GammaClient {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: config.gammaHost,
            timeout: 15000,
            headers: {
                'Accept': 'application/json',
            },
        });
    }

    /**
     * Fetch active events from Polymarket
     */
    async getActiveEvents(limit: number = 100): Promise<PolymarketEvent[]> {
        try {
            const response = await this.client.get<GammaEventsResponse>('/events', {
                params: {
                    active: true,
                    closed: false,
                    limit,
                },
            });

            return response.data.map(event => ({
                id: event.id,
                slug: event.slug,
                title: event.title,
                description: event.description,
                active: event.active,
                closed: event.closed,
                startDate: event.startDate,
                endDate: event.endDate,
                tags: event.tags,
                markets: event.markets.map(market => this.parseMarket(market)),
            }));
        } catch (error) {
            logger.error('Failed to fetch active events', { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Search for events/markets by tag
     */
    async getEventsByTag(tagId: string, limit: number = 50): Promise<PolymarketEvent[]> {
        try {
            const response = await this.client.get<GammaEventsResponse>('/events', {
                params: {
                    tag_id: tagId,
                    active: true,
                    closed: false,
                    limit,
                },
            });

            return response.data.map(event => ({
                id: event.id,
                slug: event.slug,
                title: event.title,
                description: event.description,
                active: event.active,
                closed: event.closed,
                startDate: event.startDate,
                endDate: event.endDate,
                tags: event.tags,
                markets: event.markets.map(market => this.parseMarket(market)),
            }));
        } catch (error) {
            logger.error('Failed to fetch events by tag', { tagId, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get all available tags
     */
    async getTags(): Promise<Array<{ id: string; label: string; slug: string }>> {
        try {
            const response = await this.client.get<Array<{ id: string; label: string; slug: string }>>('/tags', {
                params: { limit: 100 },
            });
            return response.data;
        } catch (error) {
            logger.error('Failed to fetch tags', { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Get a specific market by slug
     */
    async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
        try {
            const response = await this.client.get<GammaMarketsResponse>('/markets', {
                params: { slug },
            });

            if (response.data.length === 0) return null;
            return this.parseMarket(response.data[0]);
        } catch (error) {
            logger.error('Failed to fetch market by slug', { slug, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Search markets by keyword
     */
    async searchMarkets(query: string, limit: number = 50): Promise<PolymarketMarket[]> {
        try {
            // Gamma API doesn't have a direct search, so we fetch all and filter
            const response = await this.client.get<GammaMarketsResponse>('/markets', {
                params: {
                    active: true,
                    closed: false,
                    limit,
                },
            });

            const lowerQuery = query.toLowerCase();
            return response.data
                .filter(market =>
                    market.question.toLowerCase().includes(lowerQuery) ||
                    market.description?.toLowerCase().includes(lowerQuery)
                )
                .map(market => this.parseMarket(market));
        } catch (error) {
            logger.error('Failed to search markets', { query, error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Parse raw market data from API
     */
    private parseMarket(raw: GammaMarketsResponse[0]): PolymarketMarket {
        // Parse JSON strings
        let outcomes: string[] = [];
        let outcomePrices: string[] = [];
        let clobTokenIds: string[] = [];

        try {
            outcomes = JSON.parse(raw.outcomes || '[]');
        } catch { outcomes = []; }

        try {
            outcomePrices = JSON.parse(raw.outcomePrices || '[]');
        } catch { outcomePrices = []; }

        try {
            clobTokenIds = JSON.parse(raw.clobTokenIds || '[]');
        } catch {
            // Sometimes it's a comma-separated string
            if (raw.clobTokenIds && typeof raw.clobTokenIds === 'string') {
                clobTokenIds = raw.clobTokenIds.split(',').map(s => s.trim());
            }
        }

        return {
            id: raw.id,
            conditionId: raw.conditionId,
            slug: raw.slug,
            question: raw.question,
            description: raw.description,
            outcomes,
            outcomePrices,
            clobTokenIds,
            active: raw.active,
            closed: raw.closed,
            endDateIso: raw.endDateIso,
            volume: raw.volume,
            liquidity: raw.liquidity,
            tags: raw.tags,
        };
    }
}
