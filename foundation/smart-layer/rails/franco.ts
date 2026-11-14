/**
 * Input rail 3a: Franco (Arabizi) to Arabic (plan 4 Task A4). Only Latin tokens that LOOK like Franco are converted: a token with a
 * Franco digit (2 3 5 7 8 9) among lowercase letters (a3ml, 3ayez, 7aga), or a known digit-free Franco word (ezay, mesh, keda).
 * English words, SKUs, codecs (mp3, h264) and all-caps codes (EID2026) are left alone. The result feeds the scope lexicon and tool
 * retrieval only; it is approximate by design (short vowels are dropped like in written Arabic) and is never shown to anyone.
 */
const WORDS: Record<string, string> = {
  ezay: 'ازاي', ezzay: 'ازاي', izay: 'ازاي', ezai: 'ازاي', mesh: 'مش', msh: 'مش', ayez: 'عايز', ayza: 'عايزة', keda: 'كده', kda: 'كده',
  fein: 'فين', feen: 'فين', leh: 'ليه', lesa: 'لسه', ahlan: 'اهلا', shokran: 'شكرا', khalas: 'خلاص', tamam: 'تمام', momken: 'ممكن', mumken: 'ممكن',
  ana: 'انا', enta: 'انت', enty: 'انتي', deh: 'ده', dah: 'ده', el: 'ال', ya3ni: 'يعني',
  '3la': 'على', '3ala': 'على', '3ashan': 'عشان', '3shan': 'عشان', '3ayez': 'عايز', '3ayza': 'عايزة', '3ayzeen': 'عايزين',
};
const DIGITS: Record<string, string> = { '2': 'ء', '3': 'ع', '5': 'خ', '7': 'ح', '8': 'غ', '9': 'ق' };
const LETTERS: Record<string, string> = { b: 'ب', c: 'ك', d: 'د', f: 'ف', g: 'ج', h: 'ه', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', v: 'ف', z: 'ز', x: 'كس' };
const DIGRAPHS: Record<string, string> = { sh: 'ش', kh: 'خ', gh: 'غ', th: 'ث', ch: 'تش' };

function translit(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    const two = t.slice(i, i + 2);
    const first = i === 0;
    const last = i === t.length - 1;
    if (DIGRAPHS[two]) { out += DIGRAPHS[two]; i++; continue; }
    if (DIGITS[c]) out += DIGITS[c];
    else if (LETTERS[c]) out += LETTERS[c];
    else if (c === 'a') out += last && i > 0 ? 'ة' : 'ا';
    else if (c === 'e') out += first ? 'ا' : '';
    else if (c === 'i') out += first ? 'ا' : 'ي';
    else if (c === 'y') out += 'ي';
    else if (c === 'o') out += first ? 'او' : 'و';
    else if (c === 'u' || c === 'w') out += 'و';
    else out += c;
  }
  return out;
}

const looksFranco = (t: string): boolean => {
  if (t.length < 3 || /[A-Z]/.test(t)) return false;
  const digits = (t.match(/[0-9]/g) ?? []).length;
  if (digits === 0 || digits > 2) return false;
  if (/[^235789a-z']/.test(t.replace(/[a-z]/g, ''))) return false; // a digit outside 2 3 5 7 8 9 (mp4, h264, v1)
  if (/[0-9]$/.test(t)) return false; // mp3, x86: a Franco digit stands for a letter inside the word
  return /[a-z]/.test(t);
};

export function francoToArabic(text: string): string {
  return text.replace(/[A-Za-z0-9']+/g, (tok) => {
    if (/[A-Z]/.test(tok)) return tok;
    const w = WORDS[tok.toLowerCase()];
    if (w) return w;
    return looksFranco(tok) ? translit(tok.replace(/'/g, '')) : tok;
  });
}
