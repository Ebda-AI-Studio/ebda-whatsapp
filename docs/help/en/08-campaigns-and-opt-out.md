# Campaigns and opt-out

A campaign is a marketing message sent with an approved template to a group of your customers. The customer must have agreed to receive messages from you.

## What you need before you start
- A connected number and an approved **marketing** template ([Templates](04-templates-and-the-24-hour-window.md)).
- Contacts who **opted in**, with the source of their consent recorded.
- Enough balance if you use the shared number ([Wallet](09-wallet-top-ups-and-refunds.md)). On your own number, Meta bills your card directly.

## Steps
1. **Contacts:** upload a CSV (up to 10 MB) with phone, name and tags. We normalize phone formats, remove duplicates and tell you which rows were rejected.
2. **Segment:** choose a group (for example a tag, or customers who wrote recently). People who opted out are always removed.
3. Choose the **template** and fill in the variables.
4. Check the **estimated cost** before confirming.
5. Send now or **schedule** a time.
6. Follow progress on the Campaigns screen. You can pause, resume or cancel.

## Consent when you import
- On the **Contacts** screen, under the file upload, there is a box: "These customers agreed to receive offers from me on WhatsApp, and I can prove it."
- Tick it only if you really have their consent. Left unticked, the contacts are added but **will not receive campaigns** until they agree.
- An import never undoes a customer's opt-out and never overwrites consent already on record.
- Before you send, the screen shows how many customers the campaign reaches, and how many it skips and why (opted out, or no consent on record).

## Tracked links
- Choose "Tracked link" for a template variable and each customer gets their own link to the page you set (it must start with https).
- The Campaigns screen shows how many customers opened the link and how many opens there were. WhatsApp's automatic link previews are not counted.

## Who can do what
- Only the store owner can create and send a campaign, or resume a paused one, because it spends money.
- Anyone on the team can pause or cancel a campaign.

## Opt-out
- If a customer writes **STOP**, **STOP ALL**, **UNSUBSCRIBE**, **CANCEL**, **OPTOUT**, **إلغاء**, **وقف**, **توقف**, **ايقاف** or **بطل**, or taps a button that says Stop, Stop all, Stop promotions or Unsubscribe, marketing to them stops immediately and the choice is recorded. Only the whole message counts: "please cancel my order" is an order question and does not opt anyone out. A button that just says "Cancel" is never an opt-out, so you can use it freely in your own templates (for example "cancel appointment").
- Your uploaded CSV is deleted from our storage as soon as the import ends (a 7-day expiry backs this up). If you erase a customer while an import is still running, that import is stopped and its file deleted; upload it again without that customer.
- Opting out on WhatsApp is also recorded at your store, so the customer is not marketed to there either.
- Order and service messages (like an order confirmation) are not affected, because they are not marketing.
- Do not add someone who opted out again without new consent from them.

## Limits
- **Tier limit:** your number has a daily limit on how many new customers you can start conversations with (250 to begin with, rising after verification and with good message quality). Meta sets it. Anything over waits until the next day automatically.
- **Balance:** if the balance runs out mid-campaign on the shared number, marketing stops and the campaign pauses with a clear reason.
- **Number quality:** if many customers report or block your messages, quality drops and the limit may go down.

## Error 131049 (frequency cap), in plain words
Sometimes Meta does not deliver a marketing message to a particular customer, so that person is not flooded with marketing from many businesses. This error does **not** mean your number or template has a problem, and it does not mean the customer blocked you. We retry after 24 hours, twice, and if it still does not deliver we leave it. Do not resend the same message by hand.

## Tips
- Send to people who are genuinely interested; fewer, sharper messages protect your quality.
- Include something useful, not a generic offer.

---
Last checked: 2026-10-25. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
