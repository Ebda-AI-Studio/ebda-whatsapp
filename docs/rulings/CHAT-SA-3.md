# CHAT-SA-3

**Ruling CHAT-SA-3 - Self-serve creation (`POST /api/v1/workspaces`, name + country EG) is flag-gated `STANDALONE_WORKSPACES=off|invite|open`; tonight production runs `invite` (operator-minted single-use code, hashed, 14-day expiry, consumed in the same D1 batch as the insert); one owned standalone workspace per identity (more only by operator); per-user 3/day and per-IP 10/day creation attempts.** Evidence: there is no Turnstile and the accounts signup has only rate limits (`app.ts:1068-1071`); an open create endpoint would let anyone mint workspaces that hold numbers and send campaigns; the new-workspace campaign cap is already owner-scoped (`campaigns/new-cap.ts:17-19`). Cost if wrong: genuine clients wait for an operator code until the flag flips to `open` (one env change).

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
