// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/redisConnect.js — Redis connection with graceful fallback.
 * Single responsibility: connect to Redis, return client or null on failure.
 */
import Redis from 'ioredis';

export async function connectRedis() {
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      lazyConnect:          true
    });
    await redis.connect();
    console.log('✅ Redis Connected');
    return redis;
  } catch (error) {
    console.warn('⚠️  Redis unavailable — using in-memory fallback:', error.message);
    return null;
  }
}
