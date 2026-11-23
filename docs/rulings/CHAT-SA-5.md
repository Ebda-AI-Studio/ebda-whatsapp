# CHAT-SA-5

**Ruling CHAT-SA-5 - For standalone workspaces the web hides every store-coupled surface (orders pane, catalogue section, COD settings/outcome, product-recommendations switch, store-link help, Store picker wording, Store-managed team text, `store-included` package card, NoWorkspace's Store link) driven by `/me.kind === 'standalone'` and `capabilities.store === false`; Smart Layer tools declare `needsStore` and store tools are not registered for standalone; copy says "workspace"/"مساحة العمل", never "store"/"متجر".** Evidence: order pane, catalogue, COD are already null-safe without a bridge; recommendations, store-link docs, Team/Seats and NoWorkspace assume a store (`web/src/components/NoWorkspace.tsx`, `TeamScreen.tsx`, `StoreMenu.tsx`). Cost if wrong: a hidden feature a standalone client could have used is missing until shown (no data risk).

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
