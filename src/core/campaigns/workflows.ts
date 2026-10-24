import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { errClass } from '../observability';
import { runImportChunk } from './import-run';

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
