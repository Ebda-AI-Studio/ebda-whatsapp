-- W2-MONEY (C2, M-096). InstaPay duplicate-proof detection and the proof lifecycle.
-- proof_sha256: SHA-256 of the uploaded image/PDF. It outlives the image (the image is deleted 180 days after the decision) so a re-used transfer is still caught.
ALTER TABLE instapay_requests ADD COLUMN proof_sha256 TEXT;
-- bank_ref: the bank's own transaction reference, typed by the operator from the proof when confirming (upper case, no spaces or dashes). Unique across workspaces among confirmed requests.
ALTER TABLE instapay_requests ADD COLUMN bank_ref TEXT;
-- held_reason: 'duplicate_image' | 'duplicate_reference'. While set, the request cannot be confirmed (it can be rejected, or released by an operator with a reason).
-- held_of: the other request that made this one a duplicate.
ALTER TABLE instapay_requests ADD COLUMN held_reason TEXT;
ALTER TABLE instapay_requests ADD COLUMN held_of TEXT;
ALTER TABLE instapay_requests ADD COLUMN held_at INTEGER;
-- Separation of duties: the operator who releases a hold may not approve or confirm that request.
ALTER TABLE instapay_requests ADD COLUMN released_by TEXT;
ALTER TABLE instapay_requests ADD COLUMN released_at INTEGER;
-- The bank reference the FIRST approver read from the proof (normalised). The second approver has to give the same one.
ALTER TABLE instapay_requests ADD COLUMN pending_bank_ref TEXT;
-- Lookups by hash and by reference (partial: most rows have neither).
CREATE INDEX instapay_requests_proof_sha ON instapay_requests (proof_sha256) WHERE proof_sha256 IS NOT NULL;
CREATE UNIQUE INDEX instapay_requests_bank_ref ON instapay_requests (bank_ref) WHERE bank_ref IS NOT NULL;
-- The proof purge walks decided requests that still hold an image.
CREATE INDEX instapay_requests_proof_purge ON instapay_requests (decided_at) WHERE proof_key IS NOT NULL;
