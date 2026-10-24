import type { WorkspaceDO } from './core/workspace-do';

export type Env = {
  WORKSPACE_DO: DurableObjectNamespace<WorkspaceDO>;
  DB: D1Database;
  SEND_QUEUE: Queue;
  MEDIA: R2Bucket;
  USAGE: AnalyticsEngineDataset;
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  META_SYSTEM_TOKEN: string;
  META_GRAPH_VERSION: string;
  COMMIT_SHA?: string;
};
