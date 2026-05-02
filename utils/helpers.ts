import crypto from 'crypto';

export function generateApiKey() {
  const buffer = crypto.randomBytes(32);
  const key = buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const prefix = key.slice(-6);
  return { key, prefix };
}

export function hashKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function formatResponse(data: any, message: string = 'Success') {
  return {
    success: true,
    message,
    data,
  };
}

export function formatError(message: string = 'Internal Server Error', code: number = 500) {
  return {
    success: false,
    message,
    code,
  };
}

export async function auditLog(supabaseClient: any, userId: string, action: string, metadata: Record<string, any> = {}) {
  try {
    await supabaseClient.from('audit_logs').insert([{ user_id: userId, action, metadata }]);
  } catch (err) {
    console.error('Audit log error:', err);
  }
}
