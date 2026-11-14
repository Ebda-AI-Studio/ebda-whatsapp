import { describe, expect, it } from 'vitest';
import { isFranco, isPlainEnglish } from '../src/core/franco';

describe('Franco-Arabic detection (audit D6)', () => {
  it.each([
    '3ayez fostan a7mar', 'ezayak ya basha', 'bekam el shipping lel Giza?', 'momken a3raf el mawa3eed', 'ana 3ayza 2ahmar', 'fein el order bta3i', 'ma3lesh ta2akhart', 'keda tamam shukran', 'ya 7abibi', 'mesh 3agbany el lon',
  ])('"%s" is Franco', (t) => expect(isFranco(t)).toBe(true));

  it.each([
    'where is my order', 'hello', 'I want size 42 in black', 'iphone15 pro max price', 'do you ship to Alexandria?', 'ok thanks', 'I need a gift under 500', 'A1', 'what time do you open', 'can I pay with 3D secure card', 'hi, do you have the v2 model',
  ])('"%s" is English', (t) => expect(isFranco(t)).toBe(false));

  it('Arabic script is never Franco; digits-only and empty are neither', () => {
    expect(isFranco('عايز فستان')).toBe(false);
    expect(isFranco('123456')).toBe(false);
    expect(isFranco('')).toBe(false);
  });

  it('isPlainEnglish: Latin letters, no Arabic script, not Franco', () => {
    expect(isPlainEnglish('where is my order')).toBe(true);
    expect(isPlainEnglish('3ayez fostan')).toBe(false);
    expect(isPlainEnglish('عايز dress')).toBe(false);
    expect(isPlainEnglish('1234')).toBe(false);
  });
});
