/**
 * Finds the workspace that owns a WhatsApp number. One D1 read per webhook and no in-isolate cache:
 * a stale route would deliver a message to another tenant (measure in the spike before adding any cache).
 */
export async function workspaceForPhoneNumber(db: D1Database, phoneNumberId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT workspace_id FROM phone_numbers WHERE phone_number_id = ? AND status = 'active'")
    .bind(phoneNumberId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}

/** Every workspace with an active number on a WABA (template webhooks name the WABA, not a number; a WABA can be shared). */
export async function workspacesForWaba(db: D1Database, wabaId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT workspace_id FROM phone_numbers WHERE waba_id = ? AND status = 'active' ORDER BY workspace_id")
    .bind(wabaId)
    .all<{ workspace_id: string }>();
  return results.map((r) => r.workspace_id);
}

/** The active number of a WABA whose display phone matches (digits only, so "+20 100 123 4567" equals "201001234567"). */
export async function numberForDisplayPhone(db: D1Database, wabaId: string, displayPhone: string): Promise<{ phoneNumberId: string; workspaceId: string } | null> {
  const want = displayPhone.replace(/\D/g, '');
  const { results } = await db
    .prepare("SELECT phone_number_id, workspace_id, display_phone FROM phone_numbers WHERE waba_id = ? AND status = 'active' AND display_phone IS NOT NULL")
    .bind(wabaId)
    .all<{ phone_number_id: string; workspace_id: string; display_phone: string }>();
  const hit = results.find((r) => r.display_phone.replace(/\D/g, '') === want);
  return hit ? { phoneNumberId: hit.phone_number_id, workspaceId: hit.workspace_id } : null;
}

/** The workspace's active sender (first connected number), or null when it has none. */
export async function activeNumberFor(db: D1Database, workspaceId: string): Promise<{ phoneNumberId: string; wabaId: string } | null> {
  const row = await db
    .prepare("SELECT phone_number_id, waba_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid LIMIT 1")
    .bind(workspaceId)
    .first<{ phone_number_id: string; waba_id: string }>();
  return row ? { phoneNumberId: row.phone_number_id, wabaId: row.waba_id } : null;
}
