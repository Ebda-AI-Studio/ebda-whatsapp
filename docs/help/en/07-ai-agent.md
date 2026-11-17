---
capabilities:
  - agent.credits-topup@2
  - agent.credits-view@2
  - agent.enable@2
  - agent.faq@1
  - agent.location-pin@1
  - agent.notify-phone@1
  - agent.persona-language@1
  - agent.promises@1
  - agent.provider-byok@1
  - agent.store-facts@1
  - agent.store-search@1
  - agent.tone@1
  - agent.voice-notes@1
  - inbox.assign-takeover@1
  - inbox.handoff-needs-human@1
  - inbox.voice-note-transcript@1
  - orders.tracking@1
---

# The AI agent

The agent replies to your customers in chat in Egyptian Arabic, searches the catalog, reports order status and starts a new order. Whenever a customer asks for a person, it hands over to you.

## What you need before you start
- A connected number and a synced catalog.
- **AI credits.** Your package gives you credits each month; if they run out, buy a credit pack by card in **Wallet > Buy AI credits** (the owner does this; see the wallet guide), wait for next month, or upgrade your package.
- A few lines about your store policies (shipping, returns, opening hours) so the agent can answer accurately.

## Steps
1. Open **AI agent** in the side rail.
2. Turn on **Turn on the AI agent**.
3. In **Reply style** write how it should speak in your own words (for example: friendly and brief). In **Reply language** choose Arabic, English or **Same as the customer**.
4. Choose the **agent tone** (warm, formal or playful).
5. In **Your store Q&A** write your shipping, exchange and payment details and any policy, so the agent answers with them. If it is under about 3,000 characters the agent reads all of it on every reply; if it is longer, the agent searches it, and the screen warns you until it is ready for search.
6. To get a WhatsApp message when a customer needs a team member, enter your number in **Your WhatsApp number for alerts** in international format (for example +201001234567).
7. In **What the agent may promise** switch on, yourself, anything you allow (refunds, discounts, free delivery, exchanges, guarantee). **Everything is off by default**, and the agent promises none of it unless you switch it on, even if your Q&A mentions it.
8. Set **how long it stays silent after handing over** in minutes (default 120).
9. Choose the **AI engine**: the built-in one (uses your credits) or your own OpenAI-compatible key (stored encrypted and never shown again).
10. Save, then test from your own phone.

Only the store owner can change these settings. Your AI credit balance shows at the top of the screen.

## What the agent knows about your store and the customer
- **Your store:** its name, shipping zones and fees, cash-on-delivery fee, return window, payment methods, opening hours and address, all read from your Ebda Store settings. Anything you did not fill in there, the agent says it will check; it never guesses a figure.
- **Search:** it uses your store's own search (it understands dialect, Franco-Arabic and typos, and meaning such as "a gift for my wife") and respects a budget the customer mentions.
- **A returning customer:** greeted by first name, with their last address remembered and offered as "same address as last time?" in two buttons while ordering. Order status always comes from the live order in Ebda Store, never from memory.
- **Memory:** the last 8 messages in full plus a short recap of earlier ones in the same chat.
- **Franco-Arabic:** "3ayez fostan a7mar" is understood and answered in Arabic. The agent answers only about your store and politely declines anything else.
- The customer sees the read tick and "typing…" as soon as the agent starts working on a reply.

## Important notes
- The agent replies **only inside the 24-hour window**. Outside it you need a template ([guide 4](04-templates-and-the-24-hour-window.md)).
- Every reply uses AI credits. When credits run out the agent stops and hands the conversation to staff.
- The agent does not change prices or add discounts. Orders, prices and stock come from Ebda Store.

## Location pins
When a customer sends a **location pin** while the agent is asking for the delivery address, the pin's name or address text becomes the delivery address and the agent shows it back. A pin with no text makes the agent ask for one line (area, street, building). Anywhere else, the agent just asks what the customer needs and offers to start an order. The coordinates are kept in the chat only until the order is placed and are never sent to the Store or to any outside service.

## Voice notes
When a customer sends a **voice note**, the agent listens to it, and the text appears under the voice note in your inbox (marked "Voice note transcript"). It then answers like it would a typed message. Voice notes longer than 2 minutes, or beyond your store's daily limit, get a polite request to type instead. If a voice note could not be understood, the inbox shows **Voice note (not transcribed)**: listen to it and reply yourself.

## Handoff to staff
The conversation is tagged **needs_human** and is highlighted in the inbox. If you set an alert number, you also get a WhatsApp message with the customer's name and their last 3 messages: a normal message if you wrote to the store number in the last 24 hours, otherwise the **handoff_alert** template (install the starter templates and wait for Meta to approve it). If neither is possible no message can be sent and you only see the tag in the inbox. Every morning at 10:00 you also get a message with how many conversations are still waiting. The agent stays silent until the handoff period passes or until a staff member replies. Choose **Take over** at the top of the chat to handle it yourself. When you reply to a customer (from the inbox or the WhatsApp Business app) or assign the chat to a person, the agent also stays silent for the handoff period, even if the chat was never handed over.
Handoff happens when the customer asks for a person, the agent cannot answer, or credits run out.

## Tips
- Put frequent questions in detail; the clearer they are, the more accurate the replies.
- Review the messages the agent wrote (they are marked) from time to time.

## Troubleshooting
- **The agent is silent:** check that it is on, no handoff is active, credits remain, and the customer wrote within the last 24 hours.
- **131047:** the agent does not reply after 24 hours; use a template.
- **A wrong reply:** edit the knowledge or persona, and take the conversation over.

---
Last checked: 2026-11-14. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
