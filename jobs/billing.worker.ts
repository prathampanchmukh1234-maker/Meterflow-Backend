import { Worker } from 'bullmq';
import { redis } from '../config/redis';
import { supabase } from '../config/supabase';
import { webhookQueue, billingQueue } from '../config/bullmq';

if (!redis) {
  console.warn('Billing worker skipped because Redis is disabled.');
} else {
new Worker('billing-jobs', async (job) => {
  const { userId } = job.data;
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { count } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('timestamp', periodStart.toISOString());

  const { data: userData } = await supabase
    .from('users')
    .select('plans(free_quota, price_per_100_requests)')
    .eq('id', userId)
    .single();

  const plan = (userData as any)?.plans;
  if (!plan) return;

  const totalRequests = count || 0;
  const freeQuotaUsed = Math.min(totalRequests, plan.free_quota || 0);
  const billable = Math.max(0, totalRequests - plan.free_quota);
  const amount = (billable / 100) * plan.price_per_100_requests;

  const { data: billRecord, error: billError } = await supabase
    .from('billing')
    .upsert([{
      user_id: userId,
      period_start: periodStart,
      period_end: now,
      total_requests: totalRequests,
      free_quota_used: freeQuotaUsed,
      billable_requests: billable,
      amount_inr: amount,
      status: amount > 0 ? 'pending' : 'paid',
    }], { onConflict: 'user_id,period_start', ignoreDuplicates: false })
    .select()
    .single();

  if (billError) {
    console.error('Billing upsert failed:', billError);
    return;
  }

  // Webhook for billing.invoice_ready
  const { data: hooks } = await supabase
    .from('webhooks')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (billRecord) {
    for (const hook of hooks || []) {
      if (hook.events.includes('billing.invoice_ready')) {
        await webhookQueue.add('deliver', {
          url: hook.endpoint_url,
          secret: hook.secret,
          payload: { 
            event: 'billing.invoice_ready', 
            amount_inr: amount, 
            invoice_id: billRecord.id,
            timestamp: new Date().toISOString() 
          }
        });
      }
    }
  }
}, { connection: redis });
}

// Scheduler: Run daily jobs to check for users needing billing

async function scheduleBillingJobs() {
  const { data: users } = await supabase.from('users').select('id');
  if (!users || users.length === 0) return;

  const existing = await billingQueue.getRepeatableJobs();
  const existingIds = new Set(existing.map((j: any) => j.id));

  let added = 0;
  for (const user of users) {
    const jobId = `billing-${user.id}`;
    if (!existingIds.has(jobId)) {
      await billingQueue.add(
        'calculate-billing',
        { userId: user.id },
        {
          repeat: { pattern: '0 0 1 * *' }, // 1st of every month at midnight UTC
          jobId,
        }
      );
      added++;
    }
  }
  console.log(`Billing scheduler: ${users.length} users total, ${added} new jobs added, ${existing.length} already scheduled`);
}

if (redis) {
  scheduleBillingJobs().catch(console.error);
}

console.log(redis ? 'Billing worker started' : 'Billing worker disabled');
