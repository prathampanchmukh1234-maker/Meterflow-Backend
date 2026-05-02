import { Queue } from 'bullmq';
import { redis } from './redis';
import axios from 'axios';
import crypto from 'crypto';

async function deliverWebhook(payload: any) {
  const body = JSON.stringify(payload.payload);
  const signature = crypto.createHmac('sha256', payload.secret).update(body).digest('hex');

  await axios.post(payload.url, payload.payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-MeterFlow-Signature': `sha256=${signature}`,
    },
    timeout: 10000,
  });
}

function createDisabledQueue(name: string) {
  return {
    async add(jobName: string, payload: any) {
      if (name === 'webhook-delivery' && jobName === 'deliver') {
        await deliverWebhook(payload);
        return { id: `direct-${Date.now()}` };
      }
      console.warn(`${name} queue skipped because Redis is disabled.`);
      return null;
    },
    async getRepeatableJobs() {
      return [];
    },
  };
}

export const billingQueue = redis
  ? new Queue('billing-jobs', {
      connection: redis,
    })
  : createDisabledQueue('billing-jobs');

export const webhookQueue = redis
  ? new Queue('webhook-delivery', {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000, // 1s -> 2s -> 4s
        },
      },
    })
  : createDisabledQueue('webhook-delivery');
