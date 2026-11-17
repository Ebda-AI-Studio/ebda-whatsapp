# Ruling WA-CAT-4

**Decision:** A cart's prices are never trusted. For a cart sent from the catalogue (`order` webhook) the bot re-reads every line from the Store (`getProducts`) before the customer picks payment: price, stock and existence are the Store's; unknown and sold-out lines are dropped with a message, a cart with stale prices says so, a cart from a different catalogue id than ours is not read. The order key is derived from the cart message id (`cart:<wamid>`), so one cart message can only become one Store order; the Store's `createOrderFromChat` re-prices again at creation.

**Evidence (2026-11-14):** Before: `bot.ts receiveCart` used Meta's `item_price` as the line price and the retailer id as the name, with no existence or stock check until order creation. Webhook payload shape from developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order. Tests: `test/catalogue-chat.test.ts` (live validation, replay, key, sold out between cart and order); mutation-checked (trusting Meta's price, a random key).

**Cost if wrong:** A customer could see one total in the cart summary and be charged another only if the Store's price changed between the summary and the order; the Store's price always wins at creation, so no money is wrongly taken, only a surprise at most. Stale stock is caught again at order creation (`out_of_stock`).
