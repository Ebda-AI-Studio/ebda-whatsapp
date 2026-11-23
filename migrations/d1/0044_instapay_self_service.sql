-- Self-service InstaPay (audit gap #3 Chat half): the merchant cancels a request that has no proof yet, and contests a rejection once. Additive and nullable.
--   cancelled_at   : the owner withdrew an `awaiting_proof` request (state becomes 'expired', so no CHECK constraint changes; this column tells the two apart).
--   contested_at / contest_note : the owner asked for a second look at a rejection (once). The request goes back to `under_review` for a PERSON; nothing is confirmed by this.
ALTER TABLE instapay_requests ADD COLUMN cancelled_at INTEGER;
ALTER TABLE instapay_requests ADD COLUMN contested_at INTEGER;
ALTER TABLE instapay_requests ADD COLUMN contest_note TEXT;
