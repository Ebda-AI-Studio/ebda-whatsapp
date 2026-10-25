import { configure } from '@testing-library/react';

// findBy*/waitFor wait on real promise chains (no timers to fake). On a loaded machine (the shared CI runner, or this Mac with other
// sessions' suites running) the 1 s default is a laptop budget; 5 s keeps the same assertions without racing the CPU.
configure({ asyncUtilTimeout: 5_000 });
