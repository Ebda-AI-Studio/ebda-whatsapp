---
capabilities:
  - inbox.send-template@1
  - inbox.send-text@1
  - inbox.window-status@1
  - templates.install-defaults@2
  - templates.list@2
  - templates.shared-list@1
  - templates.shared-number-marketing@1
  - templates.shared-request@1
  - templates.starter-on-connect@2
  - templates.sync@2
appPath: /templates
---

# Templates and the 24-hour window

This is the most important rule in WhatsApp Business: **you can write free text to a customer only if they messaged you in the last 24 hours.** After that you must use a template approved by Meta.

## The 24-hour window
- When a customer sends you a message, a 24-hour window opens. Inside it you can reply with any text, image or file.
- Every new message from the customer renews the window.
- When the window closes, free replies are blocked. You will see that the window is closed, and you can send a template instead.
- The AI agent in Ebda Chat replies **only inside the window**.

## Templates
A template is a ready-made message that Meta reviews before you can use it. It has fixed text and variables (such as the customer name and order number).

Template types:
- **Utility:** order confirmation, shipping, COD confirmation.
- **Marketing:** offers and campaigns. These need the customer's opt-in and are never sent to someone who opted out.
- **Authentication:** verification codes (OTP).

## Your starter templates
When you connect your own number, Ebda Chat reads the templates you already have at Meta and sends the missing ready-made ones (order confirmation, COD confirmation, shipping, verification code and so on) for review. You do not have to do anything. If they are not on the **Templates** page yet, open it: an empty page installs them once for you. **Sync with Meta** pulls the current status of every template at any time.

## Steps: create a template
1. Open **Templates** in the side menu and choose **New template**.
2. Pick what it is for: a service message about an order, a marketing message, or a verification code. Then pick the language.
3. Give it a name for yourself. Customers never see it.
4. Write the message. Press **Add a variable** where the customer name or order number goes, and write an example for each variable: Meta needs the examples to review it. Optionally add a header, a footer and buttons (quick replies, a link, a call button, a copy-code button).
5. The page checks Meta's rules while you type and tells you in plain words what to fix. Errors stop the send button; a warning (for example wording that looks like an offer inside a service message) you tick to confirm.
6. Press **Review and send to Meta**. You see the message as the customer will see it. **A template sent to Meta cannot be taken back**: you can edit or delete it later, but not recall the submission. Confirm to send.
7. Meta reviews it, which takes up to 24 hours. The status on the page changes by itself: **Live**, **In Meta review**, **Rejected**, **Paused**, **Disabled**.

Limits Meta sets (the page applies them for you): the text is up to 1024 characters; a header up to 60 characters with at most one variable; a footer up to 60 characters with no variable; up to 10 buttons, up to 2 link buttons and 1 call button, each button label up to 25 characters; verification-code templates have fixed wording, no links and no emojis, and the code is valid from 1 to 90 minutes. Text headers only for now; for a picture header create the template once in WhatsApp Manager and press **Sync with Meta**.

## Tips
- Write clearly without exaggeration, and avoid odd shortened links.
- A variable cannot start or end the message ("{{1}} thank you" is rejected), and variables run in order from 1 with no gaps.
- Pick the right category. If Meta decides that a "utility" template is really marketing, it changes its category and tells you after you send. It is then treated as marketing: the customer must have agreed to marketing, each message costs more, and it counts toward your campaigns.
- Approved templates can be edited once every 24 hours and 10 times a month (Meta's rule). The page shows when you can edit again.

## A rejected template
Open it from the list. You see the reason in plain words and Meta's own reason code below it. Press **Edit and resubmit**, fix the text and send it again **with the same name**: a rejected template can be edited as many times as you need.

## Deleting a template
Open the template and press **Delete the template**. Every campaign that uses it must finish first. The name of an approved template cannot be used again for 30 days after it is deleted. A template Meta disabled cannot be deleted.

## On the shared number
If you send from the shared number, you use the ready-made templates the platform keeps there: open **Templates** to see them. Marketing messages and campaigns are not available on the shared number; connect your own number for those. If you need a service or verification-code template that is not there, use **Request a service template** on the same page and the team will create it.

## Troubleshooting
- **131047 - the window is closed:** more than 24 hours passed since the customer's last message. Send a template instead of a free message.
- **Template rejected:** usually the wrong category, wrongly written variables, vague text or prohibited content. Open the template on the Templates page, read the reason, edit and resubmit.
- **Template "pending review" for a while:** Meta takes up to 24 hours. After an hour Ebda Chat asks Meta by itself; you can also press **Sync with Meta**.

---
Last checked: 2026-11-14. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
