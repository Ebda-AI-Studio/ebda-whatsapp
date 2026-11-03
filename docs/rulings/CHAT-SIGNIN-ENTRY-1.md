# Ruling CHAT-SIGNIN-ENTRY-1

**Decision (2026-11-03):** a signed-out visitor at wa.ebda.app sees Ebda Chat's own sign-in entry (`SignInGate`: studio lockup ابدأ ستوديو, then ابدأ شات), not the Store login. The page takes no credentials; its button goes to `accounts.ebda.app/login?product=chat&return=<wa url>` and never redirects by itself. A non-401 token failure shows a `role=alert` page with a retry (was a blank page).

**Evidence:** the bounce was a client redirect (`web/src/data/auth.ts` on a 401) into accounts `/login`, which answers GET with a 302 to `store.ebda.app/login` and drops `return` (Store Ruling ACCOUNTS-ENTRY-1). The form (password, MFA, passkey) lives in the Store app, so Chat does not copy it.

**Cost if wrong:** one extra click before sign-in; until the Store reads `product` and keeps `return`, the Store form still says Ebda Store and does not send the person back to wa.ebda.app on its own.
