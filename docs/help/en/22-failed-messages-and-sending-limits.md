---
capabilities:
  - inbox.failed-retry@1
  - inbox.send-throttle@1
---

# A message failed or is slow: why, and what to do

## A message marked "failed"
Under a failed message you see a warning mark and a **Try again** button. Press it and the message is sent again.

Temporary errors (such as a connection problem at Meta) are retried by the app by itself before a message is marked failed. So a message that failed after that usually will not be fixed by retrying right away. These are the codes Meta returns most often; support will ask for the code if you contact us:
- **131026:** the number is not on WhatsApp, or the customer blocked you. Nothing to do except reach them another way.
- **131047:** more than 24 hours since the customer last wrote. Send an approved template ([templates guide](04-templates-and-the-24-hour-window.md)).
- **131049:** Meta limited marketing messages to this customer because they received many. Wait, or send a service message if they reply ([campaigns guide](08-campaigns-and-opt-out.md)).
- **131051:** the message type is not supported ([sending files guide](21-send-files-in-chat.md)).
- **132001:** the template does not exist at Meta. Pick another one in **Templates**.
- **2494051:** there is no payment method on your Meta account. Add one using the [Meta fees guide](10-meta-fees-explained.md).

The app does not translate the code into a reason next to each message, so if the code is not in this list send it to ahlan@ebda.app.

## Messages that are slow
WhatsApp puts two limits on a number:
1. **How many new conversations you can start per day** (50, 250, 1,000, 10,000, 100,000 or unlimited; it rises as your business is verified and your number keeps good quality). When you reach it, the extra new conversations wait until the next day and go out by themselves. Your current limit shows under **WhatsApp number**.
2. **Sending speed on the number.** If you send a lot at once (such as a big campaign) messages queue up and go out at the speed Meta allows.

In both cases there is nothing for you to do. Messages are not lost. **Try again** will not speed them up.

---
Last checked: 2026-11-14.
