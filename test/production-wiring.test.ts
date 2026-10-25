import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { agentConfig } from '../src/core/ai/config';

// This file never calls useAgent()/configure*(): it sees only what the deployed Worker module sets up at load time.
// Every agent test configures the copy itself, which once hid that production never did (the agent could not switch on).
it('the deployed Worker configures the AI agent copy at load (the agent can switch on in production)', async () => {
  expect((await SELF.fetch('https://wa.test/health')).status).toBe(200); // the Worker module has loaded
  expect(agentConfig().copy).toBe(EBDA_AGENT_COPY);
});
