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

/** The workspace behind a WABA (template and tier webhooks name the WABA, not a number). Null if none of its numbers is active. */
export async function workspaceForWaba(db: D1Database, wabaId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT workspace_id FROM phone_numbers WHERE waba_id = ? AND status = 'active' ORDER BY rowid LIMIT 1")
    .bind(wabaId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}
