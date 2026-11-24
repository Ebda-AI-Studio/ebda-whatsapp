# Ruling CHAT-ASSIST-ORDERS-1

**Decision:** Orders and sales questions ("كام طلب النهارده؟", "What were my sales this week?") are answered by the tool `store_orders_summary` (Store bridge `getOrdersSummary`, owner only) on a store-linked workspace. The fixed no-source reply (`NO_STORE_METRICS`) now applies only to a workspace with no Store bridge (`observeTurn({ storeLinked })`). The tool prints money as `12,345.50 EGP` / `12,345.50 جنيه` (Latin digits, comma grouping, currency word per language: the house style, and what the invented-figure guard compares) and the model answers in the question's language (`answerLanguage`). A staff session gets `owner_only`, never a number. Definitions and the 60 s BOUNDED-stale cache are the Store's ruling of the same name.

**Evidence:** `test/smart-layer/store-tools.test.ts` (language and formatting, default period, owner only, no invented figure, Store down is a tool failure, empty period, routing by `storeLinked`); route `GET /store/orders-summary` in the route-authz matrix (owner) and scopes (`person_only`); capability `store.orders-summary`. Mutation check: forcing `storeLinked: false` fails 7 tests.

**Cost if wrong:** an owner reads a figure up to a minute old (the Store dashboard is live); an owner whose COD cash is recorded late sees `salesCollected` below the orders booked, and the answer says "collected".
