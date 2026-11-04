# Chat sign-in entry, brand sweep, acceptable use (2026-11-03)

Branch `fix/chat-login-brand-aup`. Rules: `CLAUDE.md`, WA-COPY-1, AR-STUDIO-NAME-1, SHARIA-AUP-1 (Store repo).

**Finish line.** Works: signed-out visitor at wa.ebda.app sees an Ebda Chat page (studio lockup, then Ebda Chat), not the Store login; the button still goes to accounts sign-in and returns to wa.ebda.app. Exercised: token provider (401 / non-401 / ok), gate component, legal pin guard, brand guard. Unchanged: token flow, audience, OIDC path, accounts API. Done: touched + related tests, typecheck, guards green.

**Finding (sign-in).** Cause is a client redirect: `web/src/data/auth.ts` sends a 401 from `accounts.ebda.app/token` to `accounts.ebda.app/login?return=...`; accounts (Store repo, Ruling ACCOUNTS-ENTRY-1) answers GET /login with a 302 to `store.ebda.app/login` and drops `return`. The form (password, MFA, passkey) lives in the Store app, so Chat does not duplicate credential handling.

**Design.**
1. Chat renders its own sign-in entry (no automatic bounce): `SignInGate`, night ground, studio lockup, one neutral button. The button goes to `accounts/login?product=chat&return=<wa url>`.
2. A non-401 token failure shows a `role=alert` page with a retry (was a blank page).
3. Store follow-up (not in this repo): accounts `/login` must keep `return` + read `product` so the Store form says Ebda Chat and returns to wa.ebda.app.
4. Legal: terms section 9 gains the SHARIA-AUP-1 bans (ar formal + en), `updated: 2026-11-03` (the repo's version marker), Arabic legal files say ابدأ شات; LEGAL_PINS refreshed.
5. Brand: tab title carries both names.
