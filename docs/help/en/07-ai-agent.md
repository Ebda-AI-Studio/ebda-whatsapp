---
capabilities:
  - agent.credits-view@2
  - agent.enable@2
  - agent.faq@1
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
- **AI credits.** Your package gives you credits each month; there is no way today to buy extra credits: if they run out, wait for next month or upgrade your package.
- A few lines about your store policies (shipping, returns, opening hours) so the agent can answer accurately.

## Steps
1. Open **AI agent** in the side rail.
2. Turn on **Turn on the AI agent**.
3. In **Reply style** write how it should speak in your own words (for example: friendly and brief). In **Reply language** choose Arabic, English or **Same as the customer**.
4. In **Your store Q&A** write your shipping, exchange and payment details and any policy, so the agent answers with them.
5. In **What the agent may promise** switch on, yourself, anything you allow (refunds, discounts, free delivery, exchanges, guarantee). **Everything is off by default**, and the agent promises none of it unless you switch it on, even if your Q&A mentions it.
6. Set **how long it stays silent after handing over** in minutes (default 120).
7. Choose the **AI engine**: the built-in one (uses your credits) or your own OpenAI-compatible key (stored encrypted and never shown again).
8. Save, then test from your own phone.

Only the store owner can change these settings. Your AI credit balance shows at the top of the screen.

## Important notes
- The agent replies **only inside the 24-hour window**. Outside it you need a template ([guide 4](04-templates-and-the-24-hour-window.md)).
- Every reply uses AI credits. When credits run out the agent stops and hands the conversation to staff.
- The agent does not change prices or add discounts. Orders, prices and stock come from Ebda Store.

## Voice notes
When a customer sends a **voice note**, the agent listens to it, and the text appears under the voice note in your inbox (marked "Voice note transcript"). It then answers like it would a typed message. Voice notes longer than 2 minutes, or beyond your store's daily limit, get a polite request to type instead. If a voice note could not be understood, the inbox shows **Voice note (not transcribed)**: listen to it and reply yourself.

## Handoff to staff
The conversation is tagged **needs_human**, is highlighted in the inbox. **No notification is sent to your phone**, so look at the inbox from time to time ([alerts guide](25-alerts-and-notices.md)). The agent stays silent until the handoff period passes or until a staff member replies. Choose **Take over** at the top of the chat to handle it yourself. When you reply to a customer (from the inbox or the WhatsApp Business app) or assign the chat to a person, the agent also stays silent for the handoff period, even if the chat was never handed over.
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
