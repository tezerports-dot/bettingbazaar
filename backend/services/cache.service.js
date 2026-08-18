// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚡ CACHE SERVICE - Redis with Graceful Fallback
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Features:
 * - Redis caching for performance
 * - Graceful fallback if Redis is unavailable
 * - In-memory cache as backup
 * - Automatic error handling
 * - Production-ready
 * 
 * @module cache.service
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let client = null;
let isRedisAvailable = false;

// In-memory fallback cache
const memoryCache = new Map();
const MEMORY_CACHE_MAX_SIZE = 1000;
const MEMORY_CACHE_TTL = 60000; // 60 seconds

/**
 * Initialize Redis Connection with graceful fallback
 */
export const initCache = async () => {
    if (client) {
        return client;
    }

    try {
        client = new Redis(REDIS_URL, {
            protocol: 2, // ioredis 6: keep RESP2 wire behaviour (see redisConnect.js)
            retryStrategy: (times) => {
                // Give up after 3 retries
                if (times > 3) {
                    console.log('⚠️  Redis connection failed. Using in-memory cache fallback.');
                    isRedisAvailable = false;
                    return null; // Stop retrying
                }
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true, // Don't connect immediately
        });

        // Event handlers
        client.on('connect', () => {
            console.log('✅ Redis Cache Connected');
            isRedisAvailable = true;
        });

        client.on('ready', () => {
            isRedisAvailable = true;
        });

        client.on('error', (err) => {
            console.error('⚠️  Redis Cache Error:', err.message);
            isRedisAvailable = false;
        });

        client.on('close', () => {
            console.log('⚠️  Redis connection closed. Switching to memory cache.');
            isRedisAvailable = false;
        });

        // Try to connect
        await client.connect();
        
    } catch (error) {
        console.error('⚠️  Redis initialization failed:', error.message);
        console.log('📦 Using in-memory cache as fallback');
        isRedisAvailable = false;
        client = null;
    }

    return client;
};

/**
 * Memory Cache Helper Functions
 */
const memoryCacheSet = (key, value, ttl) => {
    // Clean up if cache is too large
    if (memoryCache.size >= MEMORY_CACHE_MAX_SIZE) {
        const firstKey = memoryCache.keys().next().value;
        memoryCache.delete(firstKey);
    }

    const expiresAt = Date.now() + (ttl * 1000 || MEMORY_CACHE_TTL);
    memoryCache.set(key, { value, expiresAt });
};

const memoryCacheGet = (key) => {
    const item = memoryCache.get(key);
    if (!item) return null;

    // Check if expired
    if (Date.now() > item.expiresAt) {
        memoryCache.delete(key);
        return null;
    }

    return item.value;
};

const memoryCacheDel = (key) => {
    memoryCache.delete(key);
};

const memoryCacheClear = () => {
    memoryCache.clear();
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PUBLIC CACHE SERVICE API
 * ════════════════════════════════════════════════════════════════════════════
 */

export const CacheService = {
    /**
     * Get value from cache
     * @param {string} key - Cache key
     * @returns {Promise<any>} Cached value or null
     */
    async get(key) {
        // Try Redis first if available
        if (isRedisAvailable && client) {
            try {
                const data = await client.get(key);
                return data ? JSON.parse(data) : null;
            } catch (error) {
                console.error('Redis GET error:', error.message);
                isRedisAvailable = false;
            }
        }

        // Fallback to memory cache
        return memoryCacheGet(key);
    },

    /**
     * Set value in cache
     * @param {string} key - Cache key
     * @param {any} value - Value to cache
     * @param {number} ttlSeconds - Time to live in seconds (default: 60)
     */
    async set(key, value, ttlSeconds = 60) {
        const valueStr = JSON.stringify(value);

        // Try Redis first if available
        if (isRedisAvailable && client) {
            try {
                await client.set(key, valueStr, 'EX', ttlSeconds);
                return;
            } catch (error) {
                console.error('Redis SET error:', error.message);
                isRedisAvailable = false;
            }
        }

        // Fallback to memory cache
        memoryCacheSet(key, value, ttlSeconds);
    },

    /**
     * Delete value from cache
     * @param {string} key - Cache key
     */
    async del(key) {
        // Try Redis first if available
        if (isRedisAvailable && client) {
            try {
                await client.del(key);
                return;
            } catch (error) {
                console.error('Redis DEL error:', error.message);
                isRedisAvailable = false;
            }
        }

        // Fallback to memory cache
        memoryCacheDel(key);
    },

    /**
     * Invalidate all keys matching a pattern
     * @param {string} pattern - Key pattern (e.g., 'user:*')
     */
    async invalidatePattern(pattern) {
        // Try Redis first if available
        if (isRedisAvailable && client) {
            try {
                const keys = await client.keys(pattern);
                if (keys.length > 0) {
                    await client.del(keys);
                }
                return;
            } catch (error) {
                console.error('Redis invalidatePattern error:', error.message);
                isRedisAvailable = false;
            }
        }

        // Fallback: Clear all memory cache (pattern matching is complex in memory)
        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            for (const key of memoryCache.keys()) {
                if (key.startsWith(prefix)) {
                    memoryCache.delete(key);
                }
            }
        }
    },

    /**
     * Clear all cache
     */
    async clear() {
        // Try Redis first if available
        if (isRedisAvailable && client) {
            try {
                await client.flushdb();
            } catch (error) {
                console.error('Redis CLEAR error:', error.message);
            }
        }

        // Always clear memory cache
        memoryCacheClear();
    },

    /**
     * Check if Redis is available
     * @returns {boolean} True if Redis is connected and ready
     */
    isRedisReady() {
        return isRedisAvailable && client && client.status === 'ready';
    },

    /**
     * Get cache status
     * @returns {object} Status information
     */
    getStatus() {
        return {
            redis: {
                available: isRedisAvailable,
                status: client ? client.status : 'disconnected'
            },
            memory: {
                size: memoryCache.size,
                maxSize: MEMORY_CACHE_MAX_SIZE
            }
        };
    }
};

/**
 * Cleanup on exit
 */
process.on('SIGTERM', async () => {
    if (client) {
        await client.quit();
    }
    memoryCacheClear();
});

process.on('SIGINT', async () => {
    if (client) {
        await client.quit();
    }
    memoryCacheClear();
});

export default CacheService;
