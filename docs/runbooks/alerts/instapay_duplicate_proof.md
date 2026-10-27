# instapay_duplicate_proof (P1)
**Severity:** P1 look today
## What it means
An InstaPay request is held because its proof image or bank reference is on another request, or because a second no-reference confirm (same workspace, same amount, within 7 days) was attempted (DUP-REF-REQUIRED-1). Fields `workspace`, `id`, `reason` (`duplicate_image` or `duplicate_reference`); `incomplete: true` means the new request is held but an earlier twin may not be yet.
## Impact
A payment is not granted until a person decides. Either a customer is waiting for a genuine payment, or someone reused a proof to be paid twice.
## Check first
1. `GET /api/v1/operator/instapay` and open both requests.
2. `GET /api/v1/operator/instapay/:id/proof-link` for each proof; compare them with the bank app.
## Fix
1. Genuine one: `POST /api/v1/operator/instapay/:id/release` with a reason.
2. The copy: `POST /api/v1/operator/instapay/:id/reject` with a reason.
3. Both look genuine (two real transfers): release both only after the bank shows two credits.
## Verify it is resolved
Neither request is still held, and the queue shows each as released or rejected.
## Related
docs/billing.md (InstaPay); alerts: instapay_proof_overdue
