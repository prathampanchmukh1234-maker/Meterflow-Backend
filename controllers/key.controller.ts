import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { generateApiKey, hashKey, formatResponse, formatError, auditLog } from '../utils/helpers';
import { webhookQueue } from '../config/bullmq';

export const getApiKeys = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { data, error } = await supabase
    .from('api_keys')
    .select('*, apis(name)')
    .eq('user_id', user.id);

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const createApiKey = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { api_id, name } = req.body;

  // ✅ Verify api_id belongs to this user
  const { data: apiRecord, error: apiError } = await supabase
    .from('apis')
    .select('id')
    .eq('id', api_id)
    .eq('user_id', user.id)
    .single();

  if (apiError || !apiRecord) {
    return res.status(403).json(formatError('API not found or does not belong to your account'));
  }

  const { key, prefix } = generateApiKey();
  const keyHash = hashKey(key);

  const { data, error } = await supabase
    .from('api_keys')
    .insert([{ 
      api_id, 
      user_id: user.id, 
      key_hash: keyHash, 
      key_prefix: prefix,
      name: name || null,
      status: 'active' 
    }])
    .select()
    .single();

  if (error) return res.status(500).json(formatError(error.message));
  
  auditLog(supabase, user.id, 'api_key.created', { api_id, prefix });
  // Return the raw key ONLY once
  res.status(201).json(formatResponse({ ...data, raw_key: key }, 'API Key generated. Copy it now, it won\'t be shown again.'));
};

export const revokeApiKey = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { error } = await supabase
    .from('api_keys')
    .update({ status: 'revoked' })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return res.status(500).json(formatError(error.message));
  
  auditLog(supabase, user.id, 'api_key.revoked', { key_id: id });

  // Webhook for key.revoked
  const { data: hooks } = await supabase
    .from('webhooks')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_active', true);

  const revokeHooks = (hooks || []).filter((h: any) =>
    h.events.includes('key.revoked')
  );
  Promise.all(
    revokeHooks.map((hook: any) =>
      webhookQueue.add('deliver', {
        url: hook.endpoint_url,
        secret: hook.secret,
        payload: { event: 'key.revoked', key_id: id, timestamp: new Date().toISOString() }
      })
    )
  ).catch(err => console.error('Webhook dispatch error (revoke):', err));

  res.json(formatResponse(null, 'API Key revoked successfully'));
};

export const rotateApiKey = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;

  const { data: oldKey, error: fetchError } = await supabase
    .from('api_keys')
    .select('api_id, name')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !oldKey) return res.status(404).json(formatError('Key not found'));

  const { key, prefix } = generateApiKey();
  const { data: newKeyData, error: insertError } = await supabase
    .from('api_keys')
    .insert([{
      api_id: oldKey.api_id,
      user_id: user.id,
      key_hash: hashKey(key),
      key_prefix: prefix,
      status: 'active',
      name: oldKey.name ?? null,
    }])
    .select()
    .single();

  if (insertError || !newKeyData) return res.status(500).json(formatError(insertError?.message || 'Failed to create new key'));

  // Only THEN mark old key as rotated
  await supabase.from('api_keys').update({ status: 'rotated' }).eq('id', id);
  
  auditLog(supabase, user.id, 'api_key.rotated', { old_key_id: id });

  // Webhook for key.rotated
  const { data: hooks } = await supabase
    .from('webhooks')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_active', true);

  const rotateHooks = (hooks || []).filter((h: any) =>
    h.events.includes('key.rotated')
  );
  Promise.all(
    rotateHooks.map((hook: any) =>
      webhookQueue.add('deliver', {
        url: hook.endpoint_url,
        secret: hook.secret,
        payload: {
          event: 'key.rotated',
          old_key_id: id,
          new_key_id: newKeyData.id,
          timestamp: new Date().toISOString()
        }
      })
    )
  ).catch(err => console.error('Webhook dispatch error (rotate):', err));

  res.status(201).json(formatResponse({ ...newKeyData, raw_key: key }, 'Key rotated. Save the new key now — it will not be shown again.'));
};
