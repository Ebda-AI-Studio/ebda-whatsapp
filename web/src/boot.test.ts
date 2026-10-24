import { describe, expect, it } from 'vitest';
import { chooseMode, pickStore } from './boot';

describe('boot', () => {
  it('a production build always runs live, even with ?sample=1', () => {
    expect(chooseMode({ dev: false }, '?sample=1')).toBe('live');
    expect(chooseMode({ dev: false }, '')).toBe('live');
  });
  it('the dev server defaults to labelled sample data; ?live=1 opts into the API', () => {
    expect(chooseMode({ dev: true }, '')).toBe('sample');
    expect(chooseMode({ dev: true }, '?live=1')).toBe('live');
  });
  it('picks the store from ?store= only if the token lists it, else the first store', () => {
    const stores = [{ id: 'a', role: 'owner' as const }, { id: 'b', role: 'staff' as const }];
    expect(pickStore(stores, '?store=b')).toBe('b');
    expect(pickStore(stores, '?store=zzz')).toBe('a');
    expect(pickStore([], '')).toBeNull();
  });
});
