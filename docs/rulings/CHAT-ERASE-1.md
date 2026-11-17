# CHAT-ERASE-1

> Section: erasure of the Smart Layer assistant journal (`sl_*` rows) in Ebda Chat (2026-11-14)

**Ruling CHAT-ERASE-1 - for Ebda Chat merchant MEMBERS (not customers), the 90-day purge of assistant (`sl_*`) rows is the erasure until the account-erasure fan-out reaches Chat; customer/contact erasure already clears assistant rows naming the contact.**

Evidence: Chat has no merchant-user erasure path today (it predates the Smart Layer), so there is nothing to call `eraseUser` from; the 90-day purge runs in `retentionPurge`, and `eraseContact` removes the `sl_turns` / `sl_audit` rows that name the contact (`test/smart-layer/erase-contact.test.ts`). Round-3 review.

Cost if wrong: a Chat staff member who asks to be erased keeps assistant history up to 90 days.
