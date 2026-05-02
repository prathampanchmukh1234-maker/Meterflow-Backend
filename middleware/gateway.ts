import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { redis } from '../config/redis';
import { hashKey } from '../utils/helpers';
import axios from 'axios';
import { webhookQueue } from '../config/bullmq';

// 1. Validate API Key
export async function validateApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ error: 'API key is required in x-api-key header or Authorization: Bearer {key}' });
  }

  const keyHash = hashKey(apiKey);

  const { data: keyData, error } = await supabase
    .from('api_keys')
    .select(`
      id, 
      status, 
      api_id, 
      user_id,
      apis:api_id (base_url, is_active, name),
      users:user_id (plan_id, plans:plan_id (rate_limit_per_minute))
    `)
    .eq('key_hash', keyHash)
    .single();

  if (error || !keyData) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (keyData.status !== 'active') {
    return res.status(403).json({ error: 'API key is revoked or rotated' });
  }

  const api = keyData.apis as any;
  if (!api.is_active) {
    return res.status(403).json({ error: 'The requested API is currently inactive' });
  }

  const userPlans = (keyData.users as any)?.plans;
  const rateLimitPerMinute = userPlans?.rate_limit_per_minute ?? 60;

  if (!userPlans) {
    console.warn(`User ${keyData.user_id} has no plan assigned — defaulting to 60 req/min`);
  }

  (req as any).apiKey = {
    id: keyData.id,
    apiId: keyData.api_id,
    userId: keyData.user_id,
    apiOwnerId: keyData.user_id,
    baseUrl: api.base_url,
    rateLimit: rateLimitPerMinute,
  };

  next();
}

// 2. Rate Limiting (Sliding Window in Redis)
export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (!redis) return next();

  const { id, rateLimit, userId } = (req as any).apiKey;
  const key = `ratelimit:${id}`;
  const now = Date.now();
  const windowSize = 60 * 1000; // 1 minute

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, now - windowSize);
  multi.zadd(key, now, now.toString());
  multi.zcard(key);
  multi.expire(key, 60);

  const results = await multi.exec();
  if (!results) return next();
  const rawCount = results[2];
  const requestCount = typeof rawCount === 'number' ? rawCount : (Array.isArray(rawCount) ? rawCount[1] : 0);
  if (isNaN(Number(requestCount))) return next(); // fail open on Redis errors
  const finalRequestCount = Number(requestCount);

  res.setHeader('X-RateLimit-Limit', rateLimit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, rateLimit - finalRequestCount));
  res.setHeader('X-RateLimit-Reset', now + windowSize);

  if (finalRequestCount > rateLimit) {
    // Non-blocking webhook dispatch — do NOT await, return 429 immediately
    (supabase
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true) as any)
      .then(({ data: hooks }: any) => {
        const limitHooks = (hooks || []).filter((h: any) =>
          h.events.includes('usage.limit_reached')
        );
        return Promise.all(
          limitHooks.map((hook: any) =>
            webhookQueue.add('deliver', {
              url: hook.endpoint_url,
              secret: hook.secret,
              payload: {
                event: 'usage.limit_reached',
                api_key_id: id,
                timestamp: new Date().toISOString(),
                current_usage: requestCount,
                limit: rateLimit,
              },
            })
          )
        );
      })
      .catch((err: any) => console.error('Rate limit webhook dispatch error:', err));

    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit of ${rateLimit} requests per minute exceeded.`,
      retryAfter: '60s',
    });
  }

  next();
}

// 3. Proxy Handler
export async function proxyRequest(req: Request, res: Response) {
  const { baseUrl, id, apiId, userId } = (req as any).apiKey;
  const gatewayPrefix = '/gateway';
  const upstreamPath = req.url.startsWith(gatewayPrefix)
    ? req.url.slice(gatewayPrefix.length)
    : req.url;
  const targetUrl = `${baseUrl.replace(/\/$/, '')}${upstreamPath}`;
  const start = Date.now();

  try {
    const { authorization, 'x-api-key': _apiKey, host: _host,
            connection, 'transfer-encoding': _te, 'content-encoding': _ce,
            ...safeHeaders } = req.headers as any;

    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...safeHeaders,
        host: new URL(baseUrl).host,
        'x-meterflow-key-id': id,
      },
      validateStatus: () => true,
      timeout: 10000,
    });

    const latency = Date.now() - start;

    logUsageToDb({
      api_key_id: id,
      api_id: apiId,
      user_id: userId,
      endpoint: req.url,
      method: req.method,
      response_status: response.status,
      latency_ms: latency,
      ip_address: req.ip as string,
      user_agent: req.headers['user-agent'] || 'unknown',
    });

    // Real-time emit
    const io = (req as any).io;
    if (io) {
      io.to(`user:${userId}`).emit('usage_event', { timestamp: Date.now(), endpoint: req.url });
    }

    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'transfer-encoding',
      'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers'
    ]);
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        res.setHeader(key, value as string);
      }
    });
    res.status(response.status).send(response.data);
  } catch (error: any) {
    const latency = Date.now() - start;
    logUsageToDb({
      api_key_id: id, api_id: apiId, user_id: userId,
      endpoint: req.url, method: req.method, response_status: 502,
      latency_ms: latency, ip_address: req.ip as string,
      user_agent: req.headers['user-agent'] || 'unknown',
    });
    res.status(502).json({ error: 'Bad Gateway', message: error.message });
  }
}

async function logUsageToDb(logData: any) {
  try {
    await supabase.from('usage_logs').insert(logData);
    // Track last used at
    await supabase.rpc('update_key_usage', { key_id: logData.api_key_id });
    
    // Potentially emit update to Socket.io here if global io is available
    // (This will be handled in server.ts)
  } catch (err) {
    console.error('Logging Error:', err);
  }
}
