---
capabilities:
  - assistant.ebda-assistant@1
  - assistant.apply-changes@1
  - support.in-product-help@1
  - store.top-products@1
  - store.coupon-create@1
  - store.orders-summary@1
---

# The Ebda Chat assistant: ask how to do anything

The assistant answers your questions about Ebda Chat in plain language and shows you the screen you need. If you ask it to change something, it prepares the change as a preview and you press **Apply**.

## How to open it
1. Press the **Assistant** button in the side rail, or press `Ctrl` + `J` (`⌘` + `J` on a Mac).
2. Type your question in your own words, in Arabic, Franco-Arabic or English. For example: "How do I send a template to a customer?" or "Where is my balance?".
3. When the answer lives on a specific screen you get a **Show me where** link that takes you straight there.

## Where its answers come from
- The official help guides; it names the guide under each answer.
- Your own data: wallet balance, package, templates, campaigns, numbers. It reads them through the same screens you use, with exactly your permissions.
- When there is no confirmed answer it says so plainly and offers to connect you with the support team.

## Changes it prepares for you
- You say "tag Mona as vip", "turn off the ordering bot" or "make a segment of customers who ordered", and it shows a **preview** with the before and after.
- Nothing changes until you press **Apply**. After applying you have 24 hours to press **Undo** and everything goes back.
- If the item changed since the preview (you edited it by hand, for example) you get a new preview instead of an overwrite of your edit.
- Every change runs with your own permissions: if your role does not allow it (a staff member on an owner-only setting) it is refused and nothing changes.
- Changes that involve money, deletion, messages to your customers, more than 20 items or a price change, or that cannot be undone (like an internal note), need your explicit confirmation: a confirm card shows the reason and you press **Yes, do it** yourself. Typing "yes" in the chat does nothing on its own, the card expires after 15 minutes, and if something changed since the card was made you get a new one.
- Campaigns: it prepares the campaign as a draft, and before sending or scheduling it shows how many people it reaches, the template with its parameters and the expected wallet cost. Messages sent to customers cannot be taken back.
- It finds a customer by the name you typed. If two customers share that name it does not guess; it asks you to be more specific.

## Ask about your store, and create a coupon
- **Best sellers:** ask "What is my best-selling product?" or "top 3 products this week". It reads your store live and answers with each product's name, units sold and revenue for today, the last 7 days or the last 30 days (30 if you do not say), up to 10 products. The numbers are your store's own; it never estimates one. 
- **Orders and sales (owner only):** ask "How many orders today?" or "What were my sales this week?" for today, yesterday, this week (the week starts on Saturday), the last 7 days or this month. It answers with the number of orders, the sales collected (paid orders plus cash-on-delivery orders that were delivered, after refunds), the refunds and the average order value, in the language you asked in. The figures come from your store and can be up to a minute old; your store dashboard is always the live source. Staff are told these figures are the owner's.
- **Create a coupon (owner only):** say "Create a 10% discount coupon for one day". Percentage coupons go from 1% to 90%, fixed coupons up to 50,000, a coupon can last up to 90 days, and you can add a usage limit and your own code (one is generated if you give none). A confirm card shows the code, the discount, the window and the limit. Nothing is created until you press **Yes, do it**; pressing twice creates one coupon. The coupon is created by your store itself, so it appears in your store's Coupons page, where you can switch it off. The assistant cannot delete a coupon, and staff cannot create one.

## What it never does
- It never asks for a password, a verification code, a key or card details, and it does not accept them if you type them. You enter those on the secure screen only, and it shows you where.
- It never says it did something it did not do. A change happens only when you press **Apply**.
- It cannot see other accounts. It works on your store only.

## Privacy and limits
- Phone numbers, e-mails and card numbers are masked before any text is stored or sent to the model.
- Conversations are kept masked for 90 days and are deleted when you delete your workspace.
- The assistant is free up to 150 messages per store per day. When you reach the limit it tells you and you can continue the next day.

## If you do not see the assistant
It is switched on store by store, in stages. If the button is missing, it is not on for your account yet; it appears by itself when it is.

## When you need a person
The assistant is the first stop and the guides are the second. If neither answers, write to **ahlan@ebda.app**: the address is also shown at the bottom of the empty assistant panel. One email per problem helps us find it fast. Please include:
1. Your store name and the email you sign in with.
2. What you were doing, what you expected, what happened and roughly when (Cairo time).
3. For a payment: the order reference from the screen or the receipt. For a message: the first 4 and last 4 digits of the customer's number, never the whole number.
Never send a password, a Meta token, a card number, a customer's full phone number or an export of chats, and keep customers' names and numbers out of screenshots.
