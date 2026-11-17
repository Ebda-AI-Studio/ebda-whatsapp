/** Golden task shape and the registry-derived safety tasks (plan 4 Task A13; C4 consumes them in each product). */
import type { RegistryView, ToolSpec, TurnStatus } from '../types';

export interface GoldenTask {
  id: string;
  lang: 'ar-EG' | 'franco' | 'en';
  class: 'answer' | 'action' | 'must_confirm' | 'must_refuse' | 'injection' | 'cross_tenant' | 'forbidden';
  turns: string[];
  capabilityId?: string;
  expect: { finalState?: string; facts?: string[]; status?: TurnStatus; previewTool?: string; noStateChange?: boolean };
}

const FRANCO: Record<string, string> = { ا: 'a', أ: 'a', إ: 'a', آ: 'a', ب: 'b', ت: 't', ث: 's', ج: 'g', ح: '7', خ: '5', د: 'd', ذ: 'z', ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: '3', غ: '8', ف: 'f', ق: '9', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: 'a', و: 'w', ي: 'y', ى: 'a', ء: '2', ئ: '2', ؤ: '2' };
/** Rough Arabic to Franco, enough to make a Franco variant of a golden question. Not a linguistic tool. */
export const arabicToFranco = (s: string): string => [...s.replace(/[ً-ٰٟ]/g, '')].map((c) => FRANCO[c] ?? c).join('');

const hasArabic = (s: string): boolean => /[؀-ۿ]/.test(s);

export function goldenFromRegistry(reg: RegistryView, tools: ToolSpec[], o: { franco?: boolean } = {}): GoldenTask[] {
  const out: GoldenTask[] = [];
  for (const cap of reg.caps.values()) {
    if (cap.status !== 'live') continue;
    const ar = cap.examples.find(hasArabic);
    if (!ar) continue;
    const tool = tools.find((t) => t.capabilityId === cap.id);
    let base: Omit<GoldenTask, 'id' | 'lang' | 'turns'> | null = null;
    if (cap.policy === 'confirm' && tool) base = { class: 'must_confirm', capabilityId: cap.id, expect: { previewTool: tool.name, noStateChange: true } };
    else if (cap.policy === 'forbidden') base = { class: 'forbidden', capabilityId: cap.id, expect: { noStateChange: true } };
    if (!base) continue;
    out.push({ id: `${base.class}:${cap.id}`, lang: 'ar-EG', turns: [ar], ...base });
    if (o.franco) out.push({ id: `${base.class}:${cap.id}:franco`, lang: 'franco', turns: [arabicToFranco(ar)], ...base });
  }
  return out;
}
