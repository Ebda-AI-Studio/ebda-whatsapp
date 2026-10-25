# Service menu, opening hours and your location

Your customers get quick answers from the bot without waiting for you: a menu of your common questions, an automatic reply when you are closed, and your store's location on a tap.

## What you need before you start
- A connected number ([guide 2](02-connect-your-own-number.md)).
- The owner account. Staff can see these settings but cannot change them.

## The service menu
1. Open **Bot** in Settings, then **Service menu**.
2. Press **Add a question**. Give it a short name (up to 24 characters) and an answer (up to 1024 characters), in Arabic and in English. Customers see the language they write in.
3. Use **Move up** and **Move down** to order the questions, and **Remove** to delete one. You can add up to 8.
4. Turn on **Turn on the service menu** and save.

The customer sees the menu when they say hello, type "menu", or write something the bot has no ready answer for. The menu also offers **Order now** (when your store is linked), **Our location** (when you set one) and **Talk to a person**. Tapping a question sends its answer and nothing else. **Talk to a person** tags the chat for your team and the bot stays quiet ([guide 7](07-ai-agent.md), Handoff to staff).

WhatsApp shows at most 10 choices in a list. The fixed choices always show, so with a location and a linked store only 7 of your questions fit.

If the menu is off or has no questions, nothing changes: the bot behaves as before.

## Opening hours and the away message
1. In **Opening hours**, turn the switch on.
2. For each day add one or two periods (for example 10:00 to 18:00 and 20:00 to 23:00). A day with no period is closed all day.
3. A period that closes at a time earlier than it opens runs past midnight (for example 22:00 to 02:00 belongs to the day it opened).
4. Write the **away message** in Arabic and in English (up to 1024 characters each).
5. Choose whether the bot and the AI agent **keep taking orders while you are closed**.

Times are Cairo time, and the switch between summer and winter time is handled for you.

When a customer writes while you are closed, they get the away message **once** for that closed period, not on every message. If you let the bot keep taking orders, it carries on after the away message. If you switch that off, the away message replaces the bot and the agent, and the customer gets nothing more until you open. When a team member has taken over a chat, the away message stays out of the way.

## Your location
1. In **Store location**, fill the place name, the address, the latitude and the longitude. A link under the fields opens the map so you can check the pin.
2. Save.

The customer gets your location on WhatsApp, followed by a map link, when they pick **Our location** or write "address", "location" or "فين". If you leave the location empty, those words are treated like any other message. **Clear the location** removes it.

## Your WhatsApp catalog
If you do not have a catalog on Meta yet, the **WhatsApp catalog** box at the top of the Bot screen has a **Create my WhatsApp catalog** button (store owner only). It creates the catalog in your Meta business, connects it to your WhatsApp number and starts filling it with your store products within a few minutes. Afterwards the box shows the catalog ID and the time of the last sync.
- If it says Meta needs catalog access, or that your business could not be identified, open **WhatsApp number**, connect your number again and approve every permission Meta asks for, including the catalog one. Then press the button again.
- If it says Meta is not answering, wait a little and press the button again. It never creates a second catalog.
- If you already have a catalog on Meta connected to this number, you do not need the button.

## Bot results
At the top of the Bot screen, **Bot results** shows how many customers reached each step of ordering on WhatsApp: **started a chat, saw the products, added to cart, went to checkout, placed the order**. Next to each step you see the share of customers who went on from the step before, so you can see where people drop off. Pick the last 7, 30 or 90 days. Below the steps, **opened the menu** and **asked for a person** are counted on their own.
- Each customer is counted **once per step per day**, however many messages they send. A customer who comes back on another day counts on each day.
- The numbers are counts only. We do not keep anyone's phone number, name or messages for this, and a customer cannot be traced from them. If a customer asks to be erased, their entry for the current day is deleted too.
- Today's numbers are live; earlier days are final. Nobody can edit these numbers; owner and staff can read them.
- "No conversations yet" means no customer talked to the bot in that period. If you see a loading error instead, press **Try again**.

## Important notes
- The bot replies only inside the 24-hour window ([guide 4](04-templates-and-the-24-hour-window.md)). All of this is a reply to a message the customer just sent, never marketing.
- The text you write is checked against WhatsApp's length limits when you save. Fields marked in red must be fixed first.
- Test from your own phone after saving.

---
Last checked: 2026-10-25. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
