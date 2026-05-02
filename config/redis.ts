import Redis from 'ioredis';
import { loadEnv } from './env';

loadEnv();

export const redisEnabled = process.env.REDIS_DISABLED !== 'true';

let redisUrl = (process.env.REDIS_URL || 'redis://localhost:6379').trim();

// Handle common copy-paste errors from CLI strings (e.g., "-u redis://...")
if (redisUrl.includes(' -u ')) {
  redisUrl = redisUrl.split(' -u ')[1];
} else if (redisUrl.startsWith('-u ')) {
  redisUrl = redisUrl.substring(3);
}

// Handle encoded spaces if present in the env var
redisUrl = decodeURIComponent(redisUrl).trim();
if (redisUrl.includes(' -u ')) {
    redisUrl = redisUrl.split(' -u ')[1];
}

export const redis = redisEnabled
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    })
  : null;

if (redis) {
  redis.on('error', (err) => {
    console.warn(`Redis unavailable (${err.message}). Queue and rate-limit features are disabled until Redis is reachable.`);
  });
  redis.on('connect', () => console.log('Redis Connected'));
} else {
  console.warn('Redis disabled via REDIS_DISABLED=true. Queue and rate-limit features are disabled.');
}
