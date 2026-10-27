# instapay_proof_purge_failed (P1)
**Severity:** P1 look today
## What it means
R2 refused to delete an InstaPay proof image that is past its retention (`purgeInstapayProofs`, src/core/billing/instapay.ts and the daily pass in src/index.ts). Fields `id` and `error`. Retried on the next daily pass.
## Impact
A payment proof (a person's bank screenshot) is kept longer than the retention promise. Not an outage; a data-minimisation gap that grows if it repeats.
## Check first
1. R2 status in the Cloudflare dashboard for the incident window.
2. Is it the same `id` two days in a row? Then it is not transient.
## Fix
1. Wait for the next daily pass if R2 had an incident.
2. A repeating `id`: delete the object by hand in the R2 dashboard (bucket for InstaPay proofs, key from the request row), then the pass clears the pointer by itself.
## Verify it is resolved
No alert on the next daily pass, and the request row's proof pointer is cleared.
## Related
docs/billing.md (proof retention); alerts: instapay_proof_overdue
