/**
 * Workers AI over the Cloudflare REST API, shaped like the `env.AI` binding so eval code and engine code take the same `AiBinding`.
 * No imports (engine rule: pure TS). A non-2xx throws a status-only error: the response body can echo prompts or account detail.
 */
export type AiBinding = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
export type RestAiOptions = { accountId: string; apiToken: string; fetch?: typeof fetch };
export type TextModel = { id: string; functionCalling: boolean; deprecatedOn?: string; pricePerMIn?: number; pricePerMOut?: number };

const BASE = 'https://api.cloudflare.com/client/v4/accounts';

export function restAiBinding(o: RestAiOptions): AiBinding {
  const f = o.fetch ?? fetch;
  return {
    async run(model, inputs) {
      const res = await f(`${BASE}/${o.accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (!res.ok) throw new Error(`workers ai ${model} failed: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; success?: boolean };
      if (body.success === false) throw new Error(`workers ai ${model} failed: success=false`);
      return body.result;
    },
  };
}

export async function listTextModels(o: RestAiOptions): Promise<TextModel[]> {
  const f = o.fetch ?? fetch;
  const out: TextModel[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await f(`${BASE}/${o.accountId}/ai/models/search?task=Text%20Generation&per_page=100&page=${page}`, { headers: { authorization: `Bearer ${o.apiToken}` } });
    if (!res.ok) throw new Error(`workers ai model search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: Array<{ name: string; properties?: Array<{ property_id: string; value?: unknown }> }> };
    const rows = body.result ?? [];
    for (const m of rows) {
      const prop = (id: string) => m.properties?.find((p) => p.property_id === id)?.value;
      const prices = prop('price');
      const price = (unit: string) => (Array.isArray(prices) ? ((prices as Array<{ unit?: unknown; price?: unknown }>).find((p) => String(p.unit).includes(unit))?.price as number | undefined) : undefined);
      out.push({
        id: m.name,
        functionCalling: prop('function_calling') === true || prop('function_calling') === 'true',
        deprecatedOn: typeof prop('planned_deprecation_date') === 'string' ? (prop('planned_deprecation_date') as string) : undefined,
        pricePerMIn: price('input tokens'),
        pricePerMOut: price('output tokens'),
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}
