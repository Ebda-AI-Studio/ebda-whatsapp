# The AI agent

The agent replies to your customers in chat in Egyptian Arabic, searches the catalog, reports order status and starts a new order. Whenever a customer asks for a person, it hands over to you.

## What you need before you start
- A connected number and a synced catalog.
- **AI credits** (some come with your package, and you can add more).
- A few lines about your store policies (shipping, returns, opening hours) so the agent can answer accurately.

## Steps
1. Open **AI agent** in Settings.
2. Turn on **Enable agent**.
3. Choose the **persona** (how it speaks, in your own words), the **agent tone** (warm, formal or playful) and the language.
4. Write your store's questions, answers and policies in the knowledge field. If it is under about 3,000 characters the agent reads all of it on every reply; if it is longer, the agent searches it, and the screen warns you until it is ready for search.
5. To get a WhatsApp message when a customer needs a team member, enter your number in **Your WhatsApp number for alerts** in international format (for example +201001234567).
6. Set the **handoff period** (default two hours).
7. Save, then test from your own phone.

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
Last checked: 2026-11-12. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
