import { env } from 'cloudflare:test';
import { encryptSecret } from '../../src/core/ai/secrets';
import { clearTokenCaches } from '../../src/core/numbers/token';

/** A merchant's own number: workspace, active phone_numbers row (kind own) and an encrypted business token for its WABA. */
export async function seedOwnNumber(phoneNumberId: string, workspaceId: string, wabaId: string, token = 'biz-token'): Promise<void> {
  const enc = await encryptSecret(token, env.TOKEN_ENC_KEY!, workspaceId);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(workspaceId, workspaceId, Date.now()),
    env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, kind, onboarding, registration) VALUES (?, ?, ?, 'active', 'own', 'cloud_api', 'registered')").bind(phoneNumberId, wabaId, workspaceId),
    env.DB.prepare("INSERT INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at) VALUES (?, ?, ?, 'own', 1, 1)").bind(wabaId, workspaceId, enc),
  ]);
  clearTokenCaches();
}
