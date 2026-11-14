// Independent review of PR 84 (Opus), Low: erasing a contact must also remove the assistant's journal rows that name them.
import { storeId } from '../helpers/api';
import { describe, expect, it } from 'vitest';
import { rows, seedNumber, workspace } from '../helpers/workspace';

describe('review (#84): erasing a contact removes the assistant rows that mention them', () => {
  it('deletes sl_turns and sl_audit rows naming the erased contact, keeps others', async () => {
    const s = storeId(9207);
    await seedNumber(`pn-${s}`, s);
    const ws = workspace(s);
    await ws.ingest({ phoneNumberId: `pn-${s}`, inbound: [{ wamid: `wamid.${s}`, from: '201012345678', ts: Math.floor(Date.now() / 1000), type: 'text', text: 'hi', profileName: 'منى السيد' }], statuses: [], receivedAt: 1 });
    const call = (op: string, args: unknown[]) => ws.smartLayer(op as never, args);
    const t = (id: string, text: string) => ({ id, storeId: s, conversationId: 'c', userId: 'u', role: 'assistant', maskedText: text, at: Date.now(), releaseId: 'r' });
    await call('appendTurn', [t('a', 'لقيت العميلة منى السيد في القائمة')]);
    await call('appendTurn', [t('b', 'رصيد المحفظة 100 جنيه')]);
    await call('appendAudit', [{ id: 'x1', storeId: s, userId: 'u', turnId: 'a', at: Date.now(), releaseId: 'r', maskedPrompt: 'دور على منى السيد', maskedOutput: '', rails: {}, toolsOffered: [], toolCalls: [], outcome: 'answered', inputTokens: 0, outputTokens: 0, model: 'm' }]);
    await call('appendAudit', [{ id: 'x2', storeId: s, userId: 'u', turnId: 'b', at: Date.now(), releaseId: 'r', maskedPrompt: 'رصيدي', maskedOutput: '', rails: {}, toolsOffered: [], toolCalls: [], outcome: 'answered', inputTokens: 0, outputTokens: 0, model: 'm' }]);
    const found = await rows(s, "SELECT count(*) AS n FROM contacts WHERE wa_id = '201012345678'");
    expect(found).toEqual([{ n: 1 }]);
    expect((await ws.eraseContact('201012345678')).completedAt).toBeGreaterThan(0);
    expect(await rows(s, 'SELECT id FROM sl_turns ORDER BY id')).toEqual([{ id: 'b' }]);
    expect(await rows(s, 'SELECT id FROM sl_audit ORDER BY id')).toEqual([{ id: 'x2' }]);
  });
});
