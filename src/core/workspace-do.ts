import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/** One tenant's data: a SQLite-backed Durable Object per workspace. */
export class WorkspaceDO extends DurableObject<Env> {}
