# Ruling WA-IDLE-1 - wa.ebda.app's realtime socket is intentional; nothing else keeps the page busy (2026-11-17)

QA sweep R3: "wa.ebda.app never reaches networkidle".

Measured (Playwright, 2026-11-17, signed-in session without a linked store and the plain landing): the page reaches `networkidle` in 1.9 s. Requests: the document, the script and stylesheet, the Cloudflare analytics beacon, one `accounts.ebda.app/token?aud=whatsapp`, the favicon and two fonts; nothing repeats. Not measured: a signed-in merchant WITH a linked store (no such login in this session), so the signed-in inbox was read from the code, not observed.

What the code does for a signed-in merchant with a store:
- ONE long-lived connection: the realtime inbox WebSocket `/api/v1/stores/<id>/ws`, opened by `connectRealtime` (web/src/main.tsx, web/src/data/api.ts). Intentional: it delivers messages as they arrive, repairs gaps with `GET /events?after=<seq>`, reconnects with backoff capped at 30 s and never gives up. Sign-out, a no-seat member and a view-as session stop it.
- Four timers touch the network, each guarded (an early return unless the thing it waits for is in flight): the credit top-up and the wallet / package order check every 8 s while one is pending (MoneySurfaces, WalletScreen x2), a running or scheduled campaign refreshes every 15 s (CampaignsScreen), an import polls every 2 s while pending or running (ContactsScreen). None runs on the inbox landing.

Decision: no code change; the socket is the product. An automated "wait for networkidle" on the signed-in app is the wrong readiness signal: wait for the inbox list instead. Pinned by `test/wa-network-idle.test.ts`: every `setInterval` in `web/src` is on the allowlist above and guarded, and the only connection constructor is the one in `data/api.ts` (mutation: an unguarded poll in a component turns it red).

Cost if wrong: if a real signed-in merchant page does poll while idle (a path I did not observe), the QA sweep keeps reading it as busy and a hidden poll costs Worker requests; the guard stops a new one being added unnoticed.
