---
capabilities:
  - bot.order-confirmations-toggle@2
  - inbox.cod-outcome@1
  - inbox.customer-orders-pane@1
  - orders.cod-confirmation@1
---

# Cash-on-delivery (COD) confirmations

The goal is fewer orders refused at the door. As soon as a COD order is created in Ebda Store, we send the customer a WhatsApp message to confirm it.

## How it works
1. The customer places a cash-on-delivery order.
2. Ebda Store asks for confirmation and Ebda Chat sends a template with two buttons: **Confirm order** and **Refuse order**.
3. The conversation is marked with a dot and a **cod_pending** tag until the customer answers.
4. If the customer taps either button, the result is recorded and sent to Ebda Store.
5. If there is no answer within 24 hours, the result is recorded as **no reply**.

The order itself (status, price, stock) belongs to Ebda Store. Ebda Chat only reports the outcome.

## What you need before you start
- Your store linked to Ebda Chat.
- A connected number ([your own](02-connect-your-own-number.md) or [the shared number](03-use-the-shared-number.md)).
- An approved COD confirmation template ([Templates](04-templates-and-the-24-hour-window.md)).
- **Order confirmations.** They are on by default and there is no switch for it on screen today: if you want to stop them or check they are on, write to ahlan@ebda.app.
- A running package. Without one no confirmation is sent and the app says "a package is required" ([wallet guide](09-wallet-top-ups-and-refunds.md)). If a renewal fails, confirmations keep working for up to 7 days.

## If the customer does not tap a button
You can open the conversation and record **Confirm** or **Refuse** yourself from the order panel (owner or staff). You get a 5-second undo before the result is sent to Ebda Store. The first answer counts; recording the opposite answer afterwards shows a conflict message.

## Tips
- Reach the customer quickly after the order; a late confirmation is worth less.
- A confirmed order is not yet paid; payment is on delivery.

## Troubleshooting
- **The template was not sent:** check that it is approved and the number is connected.
- **131047 (window closed):** this means a free-text message was sent after 24 hours. COD confirmation is sent as a template, so if you see it, review [Templates](04-templates-and-the-24-hour-window.md).
- **The customer tapped the button twice:** no problem, the result is recorded once.
- **The result did not reach Ebda Store:** we retry automatically.

---
Last checked: 2026-11-14. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
