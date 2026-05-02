import { Worker } from 'bullmq';
import { redis } from '../config/redis';
import axios from 'axios';
import crypto from 'crypto';

export async function deliverWebhook(url: string, secret: string, payload: any) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-MeterFlow-Signature': `sha256=${signature}`,
    },
    timeout: 10000,
  });
}

if (!redis) {
  console.warn('Webhook worker skipped because Redis is disabled.');
} else {
new Worker('webhook-delivery', async (job) => {
  const { url, secret, payload } = job.data;
  await deliverWebhook(url, secret, payload);
}, { connection: redis });
}

console.log(redis ? 'Webhook worker started' : 'Webhook worker disabled');
