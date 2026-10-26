import { configure } from '@testing-library/react';

// findBy*/waitFor wait on real promise chains (no timers to fake). On a loaded machine (the shared CI runner, or this Mac with other
// sessions' suites running) the 1 s default is a laptop budget; 5 s keeps the same assertions without racing the CPU.
// CI-only override (VITEST_ASYNC_TIMEOUT): the self-hosted runner stalls on I/O (a 1 s file took >5 s there); locally it stays a strict 5 s.
configure({ asyncUtilTimeout: Number(process.env.VITEST_ASYNC_TIMEOUT ?? 5_000) });
