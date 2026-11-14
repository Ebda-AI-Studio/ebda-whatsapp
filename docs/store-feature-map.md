# Store WhatsApp features → Ebda Chat

The WhatsApp features that Ebda Store carried through its previous integration, each mapped to where Ebda Chat provides it (checked against the code on 2026-10-25). Store-side WhatsApp features go through Ebda Chat only; the Store's old bridge is being removed.

| Previous Store feature | Ebda Chat | Where |
|---|---|---|
| Order updates: paid | **Built.** `order.status_changed` → `paid` sends the payment confirmation to the customer (InstaPay / payment-link orders, inside the 24 h window) | `src/core/store-link/events.ts`, copy in `src/addons/ebda/store-copy.ts` |
| Order updates: shipped / delivered / failed delivery | **Built.** `shipment.updated` sends the status template (shipped, delivered, could not be delivered), with the tracking link when the Store sends one | `src/core/store-link/events.ts`, `docs/store-link.md` |
| COD confirmation (new; the Store never had it) | **Built.** `order.cod_confirmation_requested` → template with confirm/cancel buttons, outcome back to the Store (`whatsapp.cod_outcome`) | `docs/store-link.md`, help guide 05 |
| Connection and key management | **Built, replaced.** Merchants connect their own number with Embedded Signup (v4+, coexistence with the WhatsApp Business app); each business token is stored encrypted per WhatsApp Business Account; or they join the shared platform number. The Store ↔ WhatsApp link uses service bindings and queues: no API keys to manage | `docs/numbers.md`, `docs/shared-number.md`, `docs/store-link.md` |
| Ordering bot: browse, cart, checkout, saved addresses | **Built.** State machine (browse with an image per product + one list, quantity by button or typed digits, cart, payment choice, saved addresses as a list with "new address" last, typed address, order, confirmation), Meta catalog carts, stock refusal | `src/core/ordering/bot.ts`, `docs/store-link.md` § ordering bot |
| Ordering bot: bot copy | **Built.** Arabic/English copy per brand pack; the bot switches language on a language word | `src/addons/ebda/store-copy.ts` |
| Ordering bot: service menu | **Built.** Merchant-editable FAQ list (up to 8 questions, Arabic and English) with Order, Our location and Talk to a person rows; opened by a greeting, the menu words or idle text. Off or empty = the previous behaviour | `src/core/front-desk.ts`, `docs/store-link.md` |
| Ordering bot: business hours | **Built.** Weekly hours (Cairo time, DST-safe, overnight periods), an away message once per closed period, and a switch for taking orders while closed (bot and agent follow it) | `src/core/front-desk-hours.ts`, `docs/store-link.md` |
| Ordering bot: location | **Built.** A WhatsApp location message plus a map link, from the menu row or the words `العنوان`, `فين`, `location` | `src/core/front-desk.ts`, `docs/store-link.md` |
| Bot analytics | **Not built** for the bot (no funnel or conversion report). Campaign link clicks are counted (Analytics Engine `LINK_CLICKS`) and shown per campaign | `src/core/campaigns/` |
| Template management | **Built.** The merchant creates, submits, edits and deletes templates on their OWN WhatsApp account from the Templates screen, sees Meta's review status and rejection reason, gets the starter set and a Meta sync when a number connects; stores on the shared number see the platform's templates and request utility ones; status by webhook plus a stale-pending sweep | `src/routes/templates.ts`, `src/core/templates-service.ts`, help guide 04, `docs/messaging-core.md` |
| Meta catalog sync and provisioning | **Built (sync).** Product events push to the merchant's Meta catalog; nightly reconcile with mass-delete protection. Provisioning, i.e. creating the catalog for the merchant, is **not built**: the merchant picks an existing catalog id, verified against their WABA | `docs/store-link.md` § Meta catalog sync |
| Abandoned carts over WhatsApp | **Built.** `cart.abandoned` → recovery template with the Store's recovery link (marketing: opt-in required, never on the shared number) | `src/core/store-link/events.ts` |
| Payment links over WhatsApp | **Built.** In the ordering bot: the order's `paymentUrl`, else the Store's payment link, else a checkout link | `src/core/ordering/bot.ts` |

## Not built (decide before launch or schedule)
1. Bot analytics (funnel: greeted → browsed → ordered).
2. Meta catalog provisioning (creating a catalog for a merchant who has none).
