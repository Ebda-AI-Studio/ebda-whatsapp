---
capabilities:
  - catalogue.commerce-toggles@1
  - catalogue.google-feeds-clash@1
  - catalogue.left-out@1
  - catalogue.link-existing@1
  - catalogue.product-cards@1
  - catalogue.provision@1
  - catalogue.resync@1
  - catalogue.status@1
  - orders.cart-to-order@1
  - storelink.bridge-health@1
---

# Your products on WhatsApp

Your Ebda Store products appear inside WhatsApp as a shop: a **shop button** on your business profile, **product cards** that the AI agent sends in the chat, and a **cart** the customer sends you, which becomes a real order in your store.

## What you need before you start
- A connected number ([guide 2](02-connect-your-own-number.md)) and your store linked.
- A WhatsApp catalog. Press **Create my WhatsApp catalog** under **Bot** in the side rail; we connect it to your number and fill it with your products.
- The owner account for the switches. Staff can see the status.

## What happens by itself
- Every product, price, stock level, picture and delete in your store reaches the catalog within minutes. A full check runs every night and fixes anything that was missed.
- Products with options (size, colour) appear as one item per option, grouped under the product.
- WhatsApp needs a **picture** for every product (a secure https link). A product without one is left out and listed under **Products not shown on WhatsApp** with the reason. Add the picture in your store and it appears at the next update, or press **Update the catalog now**.
- The **shop button** and the **cart** are switched on for you. You can turn either off on the same screen. **Turn them off here, not in WhatsApp Manager or the Business app**: a change made only in Meta is put back at the next check (within two days), because Ebda Chat keeps your choice from this screen.

## In the chat
When a customer asks to see products, the AI agent sends cards with the picture, name and price (several products arrive as one list). The customer taps a product, adds it to the cart and sends the cart. We read every line again from your store (price, stock, whether it still exists), tell the customer about anything sold out or changed, ask how they want to pay and where to deliver, and create the order in your store. One cart message becomes one order, even if WhatsApp delivers it twice.

If the catalog is not connected or a product is not in it yet, the agent answers in text with the product link instead.

## Use only one source
Ebda Chat is the only thing that should write to the catalog linked to WhatsApp. **Do not also connect your Google product feed link to this catalog in Meta**: every product would appear twice. If you need a catalog for ads, make a separate one.

## If something looks wrong
- **Meta needs catalog access**: reconnect your number from **WhatsApp number** and approve the catalog permission, then press **Update the catalog now**.
- **The update is delayed**: we retry on our own. If it lasts more than a day, contact us.
- **A product is not shown**: check the reason under **Products not shown on WhatsApp**.
