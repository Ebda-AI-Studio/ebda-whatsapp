---
capabilities:
  - bot.order-confirmations-toggle@2
  - bot.ordering-toggle@2
  - inbox.send-throttle@1
  - otp.toggle@1
---

# Bot switches and sending speed

Three switches decide what Ebda Chat does for your customers automatically, and one panel shows how fast your messages go out. All of it is on the **Bot** screen.

## What you need before you start
- A connected number ([your own](02-connect-your-own-number.md) or [the shared number](03-use-the-shared-number.md)). Without a number the sending panel only says to connect one.
- The store owner account. Staff can see the switches and the sending panel but cannot change a switch.

## The three switches
Open **Bot**, then **Bot switches**. A switch you turn off takes effect straight away. A switch you turn **on** that sends messages to customers asks you to confirm first.

- **Ordering bot** (on by default). When it is on, customers can order from the chat. When you turn it off, customers cannot order from the chat; their messages still reach you and your team. Turning it on again needs no confirmation.
- **Order confirmation messages** (on by default). When your store receives a new order, the customer gets a confirmation on WhatsApp. It needs an approved order confirmation template ([Templates](04-templates-and-the-24-hour-window.md)). Turning it **on** asks you to confirm because customers will receive messages and each one is charged to your wallet. Turning it off needs no confirmation.
- **Store-login codes over WhatsApp** (off by default). The sign-in code for your store can reach the customer on WhatsApp instead of email; email stays the main way. It needs your own number (not the shared one) and an approved verification-code template. Turning it **on** asks you to confirm because each code sent is charged to your wallet. Turning it off needs no confirmation.

When you press a switch that needs confirmation, a box appears under it with the reason. Choose **Yes, turn it on** to finish, or **No, leave it off**. The confirmation is valid for 5 minutes and works once. If it expires, press the switch again.

Every change is written to the action log with who changed which switch and to what.

## Sending speed and message limit
**Sending speed and message limit** shows:
- Your **limit for new conversations** per 24 hours. Meta sets it and raises it as your quality stays good.
- How many of those you **used in the last 24 hours**.
- Your **sending speed** in messages per second.
- How many messages are **waiting for their turn**. When you reach the limit, new messages wait for a free slot and go out by themselves, so you do not need to send them again. The panel then shows when the next slot frees up.

Staff can read this panel too.

## If something is off
- Customers say they get no order confirmation: check the switch is on and that the confirmation template is approved.
- The ordering bot does not answer: check **Ordering bot** is on.
- Messages are late: look at **waiting for their turn** and the limit above.

Last checked: 2026-11-14.
