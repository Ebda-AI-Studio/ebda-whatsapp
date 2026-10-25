import { Hono } from 'hono';
import { createImportFields, importMapping } from '../core/api/contract';
import { MAX_IMPORT_BYTES } from '../core/campaigns/contacts';
import { apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

export const importsRoutes = new Hono<ApiEnv>();

/** Multipart overhead allowed on top of the file itself. */
const OVERHEAD_BYTES = 16 * 1024;
const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/x-csv']);
/** Excel and Windows save a CSV as one of these; they are accepted only when the name says .csv. */
const CSV_BY_NAME_TYPES = new Set(['application/vnd.ms-excel', 'text/plain', 'application/octet-stream', '']);

const ownerOnly = (c: ApiContext) => c.get('storeRole') !== 'staff';

/**
 * Uploads a contact file (CSV, up to 10 MB) to R2 and starts the import workflow. `consented=true` is the merchant's statement that
 * these people agreed to receive messages; without it the contacts are saved but marketing to them stays blocked.
 */
importsRoutes.post('/stores/:storeId/imports', async (c) => {
  if (!ownerOnly(c)) return apiError(c, 403, 'forbidden');
  const declared = c.req.header('content-length');
  if (declared === undefined || !/^\d+$/.test(declared)) return apiError(c, 411, 'invalid_request', 'length_required');
  if (Number(declared) > MAX_IMPORT_BYTES + OVERHEAD_BYTES) return apiError(c, 413, 'invalid_request', 'file_too_large');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return apiError(c, 400, 'invalid_request');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return apiError(c, 400, 'invalid_request', 'file_required');
  const isCsvName = /\.csv$/i.test(file.name);
  if (!CSV_TYPES.has(file.type) && !(isCsvName && CSV_BY_NAME_TYPES.has(file.type))) return apiError(c, 415, 'unsupported_media', 'csv_only');
  if (file.size > MAX_IMPORT_BYTES) return apiError(c, 413, 'invalid_request', 'file_too_large');
  const fields = createImportFields.safeParse({ consented: form.get('consented') ?? undefined, mapping: form.get('mapping') ?? undefined });
  if (!fields.success) return apiError(c, 400, 'invalid_request');
  let mapping: ReturnType<typeof importMapping.parse> | null = null;
  if (fields.data.mapping !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(fields.data.mapping); } catch { return apiError(c, 400, 'invalid_request', 'mapping_not_json'); }
    const m = importMapping.safeParse(parsed);
    if (!m.success) return apiError(c, 400, 'invalid_request', 'mapping_invalid');
    mapping = m.data;
  }
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const storeId = c.req.param('storeId');
  const id = crypto.randomUUID();
  const r2Key = `imports/${storeId}/${id}.csv`;
  // The workspace takes the slot first: one import at a time, so a second upload never writes a file nothing will read.
  const slot = await ws.createImport({ id, filename: file.name, r2Key, size: file.size, consented: fields.data.consented, mapping, actor: c.get('principal').userId });
  if (!slot.ok) return apiError(c, 409, 'invalid_request', slot.reason);
  try {
    const fixed = new FixedLengthStream(file.size);
    void file.stream().pipeTo(fixed.writable);
    await c.env.MEDIA.put(r2Key, fixed.readable, { httpMetadata: { contentType: 'text/csv' } });
    await c.env.IMPORT_WORKFLOW.create({ id, params: { workspaceId: storeId, importId: id } });
  } catch (err) {
    await ws.failImport(id, 'could_not_start');
    console.error(JSON.stringify({ alert: 'import_start_failed', workspace: storeId, error: (err as Error).name }));
    return apiError(c, 503, 'rate_limited', 'could_not_start');
  }
  return c.json({ id, status: 'pending' }, 202);
});

importsRoutes.get('/stores/:storeId/imports', async (c) => {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json({ items: await ws.listImports(20) });
});

importsRoutes.get('/stores/:storeId/imports/:importId', async (c) => {
  const ws = await workspaceStub(c);
  const imp = ws && (await ws.getImport(c.req.param('importId')));
  return imp ? c.json(imp) : apiError(c, 404, 'not_found');
});

/** Line number and reason of each rejected row (the first 1,000). The phone number itself is never kept. */
importsRoutes.get('/stores/:storeId/imports/:importId/rejects', async (c) => {
  const ws = await workspaceStub(c);
  const items = ws && (await ws.importRejects(c.req.param('importId')));
  return items ? c.json({ items }) : apiError(c, 404, 'not_found');
});
