# Ruling CHAT-AGENT-4

**Decision:** A handoff reaches the owner (audit D3). With `notifyPhone` set, ONE notice per handoff goes to that number: free text (shopper name + last 3 lines, masked) while the owner's own 24 h window is open, else the approved UTILITY template `handoff_alert`, else the alert `handoff_owner_unreachable` (the inbox badge stays). A daily task `handoff_digest` (10:00 Africa/Cairo) sends how many `needs_human` conversations still wait. Web push and e-mail are NOT offered: this repo has neither path to a merchant.

**Evidence:** `test/handoff-notify.test.ts` (window text, template, unreachable alert, one notice per handoff, no self-page, digest schedule and idempotence). Mutation check: removing the self-page guard turns its test red. The template `handoff_alert` (ar/en) joins the starter set and is useless until Meta approves it: NOT VERIFIED live (needs a real number and an approved template).

**Cost if wrong:** until the template is approved, an owner outside the 24 h window gets no WhatsApp alert (only the badge and the 10:00 digest, which has the same two-channel limit); the notice goes through the owner's number as a contact, so the owner sees a conversation with themselves in the inbox.
