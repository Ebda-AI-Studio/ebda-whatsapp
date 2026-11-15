/**
 * Capabilities the assistant cannot DO, only point to (plan 4 Task E0). Each entry says why, and `show_me_where` still opens the screen. Two honest reasons exist:
 *  - `secret`: the task needs a secret (a password, a card, a model key, a one-time token, an OAuth sign-in). The assistant never asks for, accepts or forwards one
 *    (spec 6.9 gap 19); the non-secret parts of the task are still answered.
 *  - `screen`: the task is a file chosen or downloaded on the screen; a chat has no file to hand over.
 * Adding an id here is a decision, not a shortcut: `test/smart-layer/coverage.test.ts` lists every entry and the registry must still contain it.
 */
export const DEEP_LINK_ONLY: Readonly<Record<string, { secret: string } | { screen: string }>> = {
  'access.signin': { secret: 'credentials (the sign-in is the identity service\'s)' },
  'access.integrator-tokens': { secret: 'an integration token, shown once' },
  'agent.provider-byok': { secret: 'the merchant\'s own model API key' },
  'numbers.connect': { secret: 'the Meta sign-in (OAuth)' },
  'wallet.card-topup': { secret: 'card details' },
  'inbox.send-media': { screen: 'a photo or file is chosen on the screen' },
  'contacts.import-csv': { screen: 'a CSV file is chosen and the consent wording is attested on the screen' },
  'contacts.export': { screen: 'a data export is a file download' },
};

/** Capabilities another part of the system owns (the assistant's own machinery): the coverage guard does not ask for a tool of their own. The assistant's own id is passed in (core never spells the brand). */
export const ownedElsewhere = (assistantCapability: string): Readonly<Record<string, string>> => ({
  [assistantCapability]: 'the assistant itself: its tools are help_search and show_me_where',
  'assistant.apply-changes': "the engine's apply, confirm and undo routes: the press is the merchant's, never a tool",
  'help.corpus-parity': 'help_search reads the same corpus',
});
