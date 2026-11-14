---
capabilities:
  - templates.edit-delete@2
  - templates.status-webhook@1
appPath: /templates
---

# Template review and rejections

Meta reviews every template, usually within minutes and up to 24 hours. This guide explains the statuses, how to read a rejection, and how to edit or delete a template.

## The statuses
- **Live:** approved. You can use it.
- **In Meta review:** sent and waiting. Up to 24 hours. After an hour Ebda Chat asks Meta by itself; you can also press **Sync with Meta**.
- **Rejected:** Meta did not approve it. See the reason on the template.
- **Paused:** Meta paused it for a while because customers reacted badly to it. Edit it and send it again.
- **Disabled:** Meta turned it off for good. It cannot be edited or deleted; create a new one with different text.
- **Being deleted:** the delete has not reached Meta yet.

## Reading a rejection
Open the template. You see the reason in plain words, and Meta's own code below it. The usual reasons:
- **Variables are formatted wrongly** (the most common). A variable must be written {{1}} with two braces each side, numbered in order from 1 with no gaps, with an example each, and the text cannot start or end with a variable.
- **Policy.** Prohibited commerce claims, sensitive data, or wording that reads like a scam or abuse. Rewrite it calmer and clearer.
- **Length or emojis.** Too long, too many emojis, or too many variables for the length of the text.
- **Duplicate.** Another template has the same text and footer. Change the text or delete the old one.
- **Wrong category.** A promotion filed as a service message. Choose marketing, or remove the offer.

If the code is one we do not know, you get the general advice and the code is shown so support can look at it.

## Edit and resubmit
Open the template and press **Edit and resubmit**. A rejected template keeps its **name** and can be edited as many times as you need; its type can be changed before approval. An **approved** template can be edited once every 24 hours and 10 times a month (Meta's rule), its type is locked, and Meta reviews it again after each edit. A template that is in review cannot be edited. The page shows when you can edit again.

## Delete
Open the template and press **Delete the template**. Every campaign that uses it must finish first, and a message still waiting to be sent counts too. Deleting removes one language only. The name of an approved template cannot be used again for 30 days after deleting it. A disabled template cannot be deleted.

## Meta tells us by itself
As soon as Meta decides (approves, rejects, pauses or disables a template) it sends us the status and the reason, and the app updates the template without you doing anything. A review takes from minutes to about a day. You see the reason when you open the template.

## When Meta changes the type
If Meta decides a "service" template is really marketing, it changes the category. From then on the customer must have agreed to marketing, each message costs more, and it counts toward your campaigns. The Templates page shows the type Meta chose, never the one you asked for.

---
Last checked: 2026-11-14. Meta's rules change; if the Meta screen in front of you differs from this guide, follow what you see.
