import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { formatError, formatResponse } from '../utils/helpers';
import { ensureUserProfile } from '../utils/profile';

type NotificationItem = {
  id: string;
  type: 'account' | 'api' | 'billing' | 'security' | 'usage';
  title: string;
  message: string;
  created_at: string;
  severity: 'info' | 'success' | 'warning' | 'danger';
};

const actionCopy: Record<string, { title: string; type: NotificationItem['type']; severity: NotificationItem['severity'] }> = {
  'api.deleted': { title: 'API deleted', type: 'api', severity: 'warning' },
  'api_key.created': { title: 'API key created', type: 'security', severity: 'success' },
  'api_key.revoked': { title: 'API key revoked', type: 'security', severity: 'warning' },
  'api_key.rotated': { title: 'API key rotated', type: 'security', severity: 'success' },
  'billing.invoice_generated': { title: 'Invoice generated', type: 'billing', severity: 'info' },
  'plan.changed': { title: 'Plan changed', type: 'billing', severity: 'success' },
  'payment.verified': { title: 'Payment verified', type: 'billing', severity: 'success' },
};

function readableAction(action: string) {
  return action
    .split('.')
    .map((part) => part.replace(/_/g, ' '))
    .join(' ');
}

function describeAudit(action: string, metadata: Record<string, any> = {}) {
  if (action === 'api_key.created') return `New key ${metadata.prefix ? `ending ${metadata.prefix}` : ''} is ready to use.`;
  if (action === 'api_key.revoked') return 'A key was revoked and can no longer call the gateway.';
  if (action === 'api_key.rotated') return 'A replacement key was generated. Update clients using the old key.';
  if (action === 'api.deleted') return 'An API and its related keys were removed.';
  if (action === 'billing.invoice_generated') return 'A billing invoice is available for review.';
  if (action === 'plan.changed') return `Your plan was changed${metadata.plan_name ? ` to ${metadata.plan_name}` : ''}.`;
  if (action === 'payment.verified') return 'Your payment was verified successfully.';
  return readableAction(action);
}

export const getNotifications = async (req: Request, res: Response) => {
  const authUser = (req as any).user;

  try {
    const profile = await ensureUserProfile(authUser);
    const notifications: NotificationItem[] = [
      {
        id: `account-${profile.id}`,
        type: 'account',
        title: profile.role === 'consumer' ? 'Consumer account ready' : 'Account ready',
        message: profile.role === 'consumer'
          ? 'Use the playground with API keys shared by an API owner.'
          : 'Manage APIs, keys, billing, and usage from your MeterFlow workspace.',
        created_at: profile.created_at,
        severity: 'info',
      },
    ];

    const { data: auditLogs, error: auditError } = await supabase
      .from('audit_logs')
      .select('id, action, metadata, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (auditError) return res.status(500).json(formatError(auditError.message));

    for (const log of auditLogs || []) {
      const copy = actionCopy[log.action] || { title: readableAction(log.action), type: 'account' as const, severity: 'info' as const };
      notifications.push({
        id: `audit-${log.id}`,
        type: copy.type,
        title: copy.title,
        message: describeAudit(log.action, log.metadata || {}),
        created_at: log.created_at,
        severity: copy.severity,
      });
    }

    if (profile.role !== 'consumer') {
      const { data: failedRequests, error: usageError } = await supabase
        .from('usage_logs')
        .select('id, endpoint, method, response_status, timestamp')
        .eq('user_id', profile.id)
        .gte('response_status', 400)
        .order('timestamp', { ascending: false })
        .limit(10);

      if (usageError) return res.status(500).json(formatError(usageError.message));

      for (const log of failedRequests || []) {
        notifications.push({
          id: `usage-${log.id}`,
          type: 'usage',
          title: log.response_status === 429 ? 'Rate limit hit' : 'Gateway request failed',
          message: `${log.method} ${log.endpoint} returned ${log.response_status}.`,
          created_at: log.timestamp,
          severity: log.response_status === 429 ? 'warning' : 'danger',
        });
      }

      const { data: pendingInvoices, error: billingError } = await supabase
        .from('billing')
        .select('id, amount_inr, status, created_at')
        .eq('user_id', profile.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5);

      if (billingError) return res.status(500).json(formatError(billingError.message));

      for (const invoice of pendingInvoices || []) {
        notifications.push({
          id: `billing-${invoice.id}`,
          type: 'billing',
          title: 'Pending invoice',
          message: `Invoice for INR ${Number(invoice.amount_inr || 0).toFixed(2)} is pending.`,
          created_at: invoice.created_at,
          severity: 'warning',
        });
      }
    }

    notifications.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json(formatResponse(notifications.slice(0, 30)));
  } catch (error: any) {
    res.status(500).json(formatError(error.message));
  }
};
