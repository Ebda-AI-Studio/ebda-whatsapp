import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { errClass } from '../observability';
import { runImportChunk } from './import-run';
import type { PageResult, StartResult } from './campaigns';

export type ImportParams = { workspaceId: string; importId: string };
/** 100k rows at 2000 per step is 50 steps; the cap only stops a runaway loop. */
const MAX_IMPORT_STEPS = 200;
const STEP_RETRIES = { limit: 5, delay: '10 seconds', backoff: 'exponential' } as const;

/** Parses an uploaded contact file in steps of a few thousand rows, each applied once (see runImportChunk). */
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: Readonly<WorkflowEvent<ImportParams>>, step: WorkflowStep): Promise<{ status: string }> {
    const { workspaceId, importId } = event.payload;
    try {
      for (let i = 0; i < MAX_IMPORT_STEPS; i++) {
        const r = await step.do(`chunk-${i}`, { retries: STEP_RETRIES, timeout: '5 minutes' }, () => runImportChunk(this.env, workspaceId, importId));
        if (r.done) return { status: r.status };
      }
      await step.do('give-up', () => this.fail(workspaceId, importId, 'too_many_steps'));
      return { status: 'failed' };
    } catch (err) {
      console.error(JSON.stringify({ alert: 'import_workflow_failed', workspace: workspaceId, error: errClass(err) }));
      await step.do('fail', () => this.fail(workspaceId, importId, 'internal_error'));
      return { status: 'failed' };
    }
  }

  private async fail(workspaceId: string, importId: string, reason: string): Promise<{ failed: true }> {
    await this.env.WORKSPACE_DO.get(this.env.WORKSPACE_DO.idFromName(workspaceId)).failImport(importId, reason);
    return { failed: true };
  }
}

export type CampaignParams = { workspaceId: string; campaignId: string; attempt: number };
/** What a campaign workflow asks of the workspace (the Durable Object stub implements it). */
export interface CampaignSteps {
  campaignStart(id: string, attempt: number): Promise<StartResult>;
  campaignActivate(id: string, attempt: number): Promise<{ state: 'go' } | { state: 'stop'; reason: string }>;
  campaignPage(id: string, attempt: number, page: number): Promise<PageResult>;
}
type Step = Pick<WorkflowStep, 'do' | 'sleepUntil'>;
const CAMPAIGN_STEP = { retries: STEP_RETRIES, timeout: '2 minutes' } as const;
/** Pages and waits one instance may take. A long, slowly released campaign ends the instance; the sweep starts the next generation. */
export const MAX_CAMPAIGN_STEPS = 2000;

/**
 * The broadcast loop: wait for the scheduled time, then page through the audience, 500 at a time, sleeping until the number's tier has
 * room again whenever it is full. Every step asks the workspace for a page by number, and the workspace answers a repeated question
 * with the stored answer (see campaignPage), so Workflows' retries and replays cannot reserve or enqueue anything twice. The loop
 * variable `page` only advances on a page that was actually queued, so it is the same on every replay.
 */
export async function runCampaign(step: Step, ws: CampaignSteps, p: CampaignParams): Promise<{ ended: string; pages: number }> {
  const start = await step.do('start', CAMPAIGN_STEP, () => ws.campaignStart(p.campaignId, p.attempt));
  if (start.state === 'stop') return { ended: start.reason, pages: 0 };
  if (start.scheduledAt !== null) {
    await step.sleepUntil('scheduled', start.scheduledAt);
    const live = await step.do('activate', CAMPAIGN_STEP, () => ws.campaignActivate(p.campaignId, p.attempt));
    if (live.state === 'stop') return { ended: live.reason, pages: 0 };
  }
  let page = start.nextPage;
  let pages = 0;
  for (let i = 0; i < MAX_CAMPAIGN_STEPS; i++) {
    const r = await step.do(`page-${i}`, CAMPAIGN_STEP, async () => {
      const answer = await ws.campaignPage(p.campaignId, p.attempt, page);
      if (answer.state === 'retry') throw new Error(`campaign page not ready: ${answer.reason}`); // Workflows retries the step with backoff
      return answer;
    });
    if (r.state === 'stop') return { ended: r.reason, pages };
    if (r.state === 'done') return { ended: 'completed', pages: pages + 1 };
    if (r.state === 'wait') {
      await step.sleepUntil(`wait-${i}`, r.until);
      continue;
    }
    page++;
    pages++;
  }
  return { ended: 'step_budget', pages };
}

/** One broadcast. `attempt` names the generation: a resumed or restarted campaign gets a new instance and the older one stops at its next step. */
export class CampaignWorkflow extends WorkflowEntrypoint<Env, CampaignParams> {
  async run(event: Readonly<WorkflowEvent<CampaignParams>>, step: WorkflowStep): Promise<{ ended: string; pages: number }> {
    const ws = this.env.WORKSPACE_DO.get(this.env.WORKSPACE_DO.idFromName(event.payload.workspaceId));
    return runCampaign(step, ws, event.payload);
  }
}
