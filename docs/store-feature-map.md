# Store WhatsApp features → Ebda WhatsApp

The WhatsApp features that Ebda Store carried through its previous integration, each mapped to where Ebda WhatsApp provides it (checked against the code on 2026-10-25). Store-side WhatsApp features go through Ebda WhatsApp only; the Store's old bridge is being removed.

| Previous Store feature | Ebda WhatsApp | Where |
|---|---|---|
| Order updates: paid | **Built.** `order.status_changed` → `paid` sends the payment confirmation to the customer (InstaPay / payment-link orders, inside the 24 h window) | `src/core/store-link/events.ts`, copy in `src/addons/ebda/store-copy.ts` |
| Order updates: shipped / delivered / failed delivery | **Built.** `shipment.updated` sends the status template (shipped, delivered, could not be delivered), with the tracking link when the Store sends one | `src/core/store-link/events.ts`, `docs/store-link.md` |
| COD confirmation (new; the Store never had it) | **Built.** `order.cod_confirmation_requested` → template with confirm/cancel buttons, outcome back to the Store (`whatsapp.cod_outcome`) | `docs/store-link.md`, help guide 05 |
| Connection and key management | **Built, replaced.** Merchants connect their own number with Embedded Signup (v4+, coexistence with the WhatsApp Business app); each business token is stored encrypted per WhatsApp Business Account; or they join the shared platform number. The Store ↔ WhatsApp link uses service bindings and queues: no API keys to manage | `docs/numbers.md`, `docs/shared-number.md`, `docs/store-link.md` |
| Ordering bot: browse, cart, checkout, saved addresses | **Built.** State machine (browse with an image per product + one list, quantity by button or typed digits, cart, payment choice, saved addresses as a list with "new address" last, typed address, order, confirmation), Meta catalog carts, stock refusal | `src/core/ordering/bot.ts`, `docs/store-link.md` § ordering bot |
| Ordering bot: bot copy | **Built.** Arabic/English copy per brand pack; the bot switches language on a language word | `src/addons/ebda/store-copy.ts` |
| Ordering bot: service menu | **Partly.** Restart words (`menu`, `طلب جديد`, …) open the ordering menu anywhere; general questions go to the AI agent (Phase 5) or a person (handoff). A merchant-configurable service menu (FAQ buttons) is **not built** | `src/core/ordering/bot.ts`, `docs/ai-agent.md` |
| Ordering bot: business hours | **Not built.** No opening-hours setting or out-of-hours reply | — |
| Ordering bot: location | **Not built.** The store's location is not sent as a WhatsApp location message (customer locations are received as messages) | — |
| Bot analytics | **Not built** for the bot (no funnel or conversion report). Campaign link clicks are counted (Analytics Engine `LINK_CLICKS`) and shown per campaign | `src/core/campaigns/` |
| Template management | **Built.** List, submit, sync from Meta, install the default templates; status updates by webhook | `src/routes/templates.ts`, help guide 04 |
| Meta catalog sync and provisioning | **Built (sync).** Product events push to the merchant's Meta catalog; nightly reconcile with mass-delete protection. Provisioning, i.e. creating the catalog for the merchant, is **not built**: the merchant picks an existing catalog id, verified against their WABA | `docs/store-link.md` § Meta catalog sync |
| Abandoned carts over WhatsApp | **Built.** `cart.abandoned` → recovery template with the Store's recovery link (marketing: opt-in required, never on the shared number) | `src/core/store-link/events.ts` |
| Payment links over WhatsApp | **Built.** In the ordering bot: the order's `paymentUrl`, else the Store's payment link, else a checkout link | `src/core/ordering/bot.ts` |

## Not built (decide before launch or schedule)
1. Configurable service menu (FAQ / quick-answer buttons).
2. Business hours and an out-of-hours reply.
3. Sending the store's location.
4. Bot analytics (funnel: greeted → browsed → ordered).
5. Meta catalog provisioning (creating a catalog for a merchant who has none).
