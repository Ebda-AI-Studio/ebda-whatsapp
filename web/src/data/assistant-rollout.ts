import { z } from 'zod';

/** Smart Layer rollout switches (super admin only): the platform cap and kill switches, and one workspace's mode. */
export type AssistantMode = 'off' | 'answer-only' | 'suggest' | 'act';
export const ASSISTANT_MODES: readonly AssistantMode[] = ['off', 'answer-only', 'suggest', 'act'];
export type AssistantPlatformFlags = {
  global: { kill?: boolean; mode: AssistantMode };
  product: { kill?: boolean };
  killedTools: string[];
  shadow?: boolean;
};
/** The server REPLACES the whole `global` value on every write, so a change always sends all three fields. */
export type AssistantFlagsPatch = {
  global?: { kill: boolean; mode: AssistantMode; shadow: boolean };
  product?: { kill: boolean };
  killedTools?: string[];
};
export interface AssistantRolloutApi {
  platform(): Promise<AssistantPlatformFlags>;
  setPlatform(patch: AssistantFlagsPatch): Promise<AssistantPlatformFlags>;
  workspaceMode(workspaceId: string): Promise<AssistantMode>;
  setWorkspaceMode(workspaceId: string, mode: AssistantMode): Promise<AssistantMode>;
}

export const assistantModeDto = z.object({ mode: z.enum(['off', 'answer-only', 'suggest', 'act']) });
export const assistantFlagsDto = z.object({
  global: z.object({ kill: z.boolean().optional(), mode: z.enum(['off', 'answer-only', 'suggest', 'act']) }),
  product: z.object({ kill: z.boolean().optional() }),
  killedTools: z.array(z.string()),
  shadow: z.boolean().optional(),
});

/** Sample mode (no server): the same shapes, held in memory. */
export function createSampleAssistantRollout(): AssistantRolloutApi {
  let flags: AssistantPlatformFlags = { global: { mode: 'answer-only' }, product: {}, killedTools: [] };
  const modes = new Map<string, AssistantMode>();
  return {
    platform: async () => structuredClone(flags),
    setPlatform: async (p) => {
      flags = {
        global: p.global ? { ...(p.global.kill ? { kill: true } : {}), mode: p.global.mode } : flags.global,
        product: p.product ? (p.product.kill ? { kill: true } : {}) : flags.product,
        killedTools: p.killedTools ?? flags.killedTools,
        ...(p.global ? (p.global.shadow ? { shadow: true } : {}) : flags.shadow ? { shadow: true } : {}),
      };
      return structuredClone(flags);
    },
    workspaceMode: async (ws) => modes.get(ws) ?? 'off',
    setWorkspaceMode: async (ws, m) => { modes.set(ws, m); return m; },
  };
}
