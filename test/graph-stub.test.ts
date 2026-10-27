import { describe, expect, it } from 'vitest';
import { stubGraph } from './helpers/graph';

// A custom responder written for one media id must not leave another inbound picture's download failing (and retrying into a later test).
describe('stubGraph media fallback', () => {
  it('a media lookup the custom responder did not really answer (200 without url) gets the default media reply', async () => {
    const g = stubGraph((c) => (c.url.includes('/media-1') ? { status: 200, json: { url: 'https://lookaside.fbsbx.com/one', mime_type: 'image/jpeg' } } : { status: 200, json: { messages: [{ id: 'w' }] } }));
    const one = await (await fetch('https://graph.facebook.com/v25.0/media-1')).json() as { url: string };
    const two = await (await fetch('https://graph.facebook.com/v25.0/media-2')).json() as { url?: string };
    expect(one.url).toBe('https://lookaside.fbsbx.com/one');
    expect(two.url).toMatch(/^https:\/\/lookaside\.fbsbx\.com\//);
    const file = await fetch(two.url!);
    expect(file.status).toBe(200);
    g.restore();
  });

  it('an explicit failure from the responder is kept (a test may want a media lookup to fail)', async () => {
    const g = stubGraph(() => ({ status: 404, json: { error: { message: 'gone' } } }));
    expect((await fetch('https://graph.facebook.com/v25.0/media-9')).status).toBe(404);
    g.restore();
  });
});
