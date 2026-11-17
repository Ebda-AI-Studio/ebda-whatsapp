---
capabilities:
  - otp.platform@1
  - otp.toggle@1
---

# Verification codes on WhatsApp

## The idea
A verification code is the code your customer receives to confirm their number (for example while signing up at your store). By default it goes by **e-mail**. It can also go on WhatsApp from your own number. There is a separate thing too: the code you receive when you sign in to your Ebda AI Studio account is sent from a number that belongs to Ebda AI Studio itself, never from your store's number.

## Sending from your number: it must be switched on first
- The feature is **off by default**. There is no button for it in the app today, so if you want it, write to ahlan@ebda.app and we help you switch it on for your store.
- You need **your own number** connected ([connect your number guide](02-connect-your-own-number.md)). The shared number does not send codes.
- You need an **approved verification-code template** (otp_code). You write it in **Templates** and choose "A verification code" ([template writing guide](16-write-and-submit-a-template.md)). Meta fixes its wording and you only choose how long a code is valid.

## Limits
- Egypt (+20) only, by default.
- 5 codes to the same number every 10 minutes, and 30 codes for the store in that window. Beyond that it pauses for a while.
- The code itself is never logged, and it is stored masked.
- The fee for a code message follows Meta's fee for the verification category ([Meta fees guide](10-meta-fees-explained.md)).

## If the code does not arrive
One of these: the customer's number is not Egyptian, too many were sent in a short time, the feature is not on for your store, no number is connected, the code template is not approved, the wallet is empty ([wallet guide](09-wallet-top-ups-and-refunds.md)), or Meta refused the send. First confirm the template is approved and the number is connected, and check the wallet.

---
Last checked: 2026-11-14.
