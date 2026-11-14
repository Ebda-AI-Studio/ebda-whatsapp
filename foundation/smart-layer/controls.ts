/**
 * Rollout controls (plan 4 Task A12, spec 6.10). Precedence: global kill > product kill > store flag; the default is `off`. A platform
 * `global.mode` caps what any store flag can reach; `shadow` forces suggest-style behaviour (previews are built and logged as "would
 * apply", nothing is applied). `canExecute` is read at EXECUTION time too (a switch flipped after a preview still stops the apply).
 */
import type { Controls, Mode, ToolSpec } from './types';

const ORDER: Mode[] = ['off', 'answer-only', 'suggest', 'act'];
const asMode = (m: unknown): Mode => (ORDER.includes(m as Mode) ? (m as Mode) : 'off');
const min = (a: Mode, b: Mode): Mode => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

export interface RawControls {
  storeFlag?: Mode;
  global?: { kill?: boolean; mode?: Mode };
  product?: { kill?: boolean };
  killedTools?: string[];
  shadow?: boolean;
}

export function resolveControls(raw: RawControls): Controls {
  const killGlobal = raw.global?.kill === true;
  const killProduct = raw.product?.kill === true;
  const shadow = raw.shadow === true;
  let mode = min(asMode(raw.storeFlag), raw.global?.mode === undefined ? 'act' : asMode(raw.global.mode));
  if (killGlobal || killProduct) mode = 'off';
  else if (shadow) mode = min(mode, 'suggest');
  return { mode, killGlobal, killProduct, killedTools: new Set(raw.killedTools ?? []), shadow };
}

export function canExecute(c: Controls, tool: ToolSpec, stage: 'preview' | 'apply' = 'apply'): 'ok' | 'killed' | 'mode' {
  if (c.killGlobal || c.killProduct || c.killedTools.has(tool.name)) return 'killed';
  if (c.mode === 'off') return 'mode';
  if (tool.policy === 'free') return 'ok';
  if (c.mode === 'act') return 'ok';
  if (c.mode === 'suggest' && stage === 'preview') return 'ok';
  return 'mode';
}
