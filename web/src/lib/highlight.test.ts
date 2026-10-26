import { describe, expect, it } from 'vitest';
import { highlight } from './highlight';

const joined = (s: { text: string }[]) => s.map((x) => x.text).join('');

describe('highlight', () => {
  it('matches Latin case-insensitively and keeps the original characters', () => {
    expect(highlight('Ahmed Sharaf', 'sha')).toEqual([{ text: 'Ahmed ', match: false }, { text: 'Sha', match: true }, { text: 'raf', match: false }]);
  });
  it('alef variants meet: a query with ا highlights أ in the text and vice versa', () => {
    expect(highlight('أحمد', 'احمد')).toEqual([{ text: 'أحمد', match: true }]);
    expect(highlight('احمد', 'أحم')).toEqual([{ text: 'احم', match: true }, { text: 'د', match: false }]);
  });
  it('taa marbuta and haa, alef maqsura and yaa are interchangeable', () => {
    expect(highlight('فاطمة علي', 'فاطمه')).toEqual([{ text: 'فاطمة', match: true }, { text: ' علي', match: false }]);
    expect(highlight('موسى', 'موسي')).toEqual([{ text: 'موسى', match: true }]);
  });
  it('tashkeel in the text does not break a match and is kept in the output', () => {
    const out = highlight('مُحَمَّد علي', 'محمد');
    expect(out[0]).toEqual({ text: 'مُحَمَّد', match: true });
    expect(joined(out)).toBe('مُحَمَّد علي');
  });
  it('Arabic-Indic digits match ASCII digits', () => {
    expect(highlight('+20 100 123', '١٠٠')).toEqual([{ text: '+20 ', match: false }, { text: '100', match: true }, { text: ' 123', match: false }]);
  });
  it('no match, empty query and empty text give one plain segment', () => {
    expect(highlight('Mona', 'zzz')).toEqual([{ text: 'Mona', match: false }]);
    expect(highlight('Mona', '  ')).toEqual([{ text: 'Mona', match: false }]);
    expect(highlight('', 'a')).toEqual([]);
  });
  it('marks every occurrence and the segments always rebuild the original text', () => {
    const out = highlight('ana wana', 'an');
    expect(out.filter((s) => s.match).map((s) => s.text)).toEqual(['an', 'an']);
    expect(joined(out)).toBe('ana wana');
  });
});
