import { configure } from '@testing-library/react';

// findBy*/waitFor wait on real promise chains (no timers to fake). On a loaded machine (the shared CI runner, or this Mac with other
// sessions' suites running) the 1 s default is a laptop budget; 5 s keeps the same assertions without racing the CPU.
// CI-only override (VITEST_ASYNC_TIMEOUT): the self-hosted runner stalls on I/O (a 1 s file took >5 s there); locally it stays a strict 5 s.
// The web project has no Node types: read the CI override through globalThis instead of `process`.
const ciTimeout = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST_ASYNC_TIMEOUT;
configure({ asyncUtilTimeout: Number(ciTimeout ?? 5_000) });

// The shell keeps its screen in the address bar: every test starts back at "/" so one test's navigation never leaks into the next.
import { afterEach } from 'vitest';
afterEach(() => { try { history.replaceState(null, '', '/'); } catch { /* not a DOM test */ } });
