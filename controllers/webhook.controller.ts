import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { formatResponse, formatError } from '../utils/helpers';
import crypto from 'crypto';
import { webhookQueue } from '../config/bullmq';

export const getWebhooks = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { data, error } = await supabase.from('webhooks').select('*').eq('user_id', user.id);
  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const createWebhook = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { endpoint_url, events } = req.body;
  const secret = crypto.randomBytes(32).toString('hex');

  const { data, error } = await supabase.from('webhooks')
    .insert([{ user_id: user.id, endpoint_url, events, secret }])
    .select().single();

  if (error) return res.status(500).json(formatError(error.message));
  res.status(201).json(formatResponse(data, 'Webhook created'));
};

export const deleteWebhook = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { error } = await supabase.from('webhooks').delete().eq('id', id).eq('user_id', user.id);
  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(null, 'Webhook deleted'));
};

export const testWebhook = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { data } = await supabase.from('webhooks').select('*').eq('id', id).eq('user_id', user.id).single();
  if (!data) return res.status(404).json(formatError('Webhook not found'));

  await webhookQueue.add('deliver', {
    url: data.endpoint_url,
    secret: data.secret,
    payload: { event: 'webhook.test', timestamp: new Date().toISOString() },
  });
  res.json(formatResponse(null, 'Test event queued'));
};
