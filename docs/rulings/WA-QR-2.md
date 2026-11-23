# WA-QR-2

> Section: quick replies, who maintains them (2026-11-17)

**Ruling WA-QR-2 - the shared quick replies are maintained by staff as well as the owner: staff answering customers can add, edit and delete them, and a delete is written to the audit log (the text is not).**

Evidence: wa#92 review. The quick-reply routes (`GET|POST /quick-replies`, `PUT|DELETE /quick-replies/:id`) are owner + staff by design, workspace-scoped, capped at 20, unique by text, and audited by the existing `auditWrites` middleware; the list is a shared set of canned wording, not customer data. The assistant has no tool for it (WA-QR-1: `inbox.quick-replies` is deep-link-only for December).

Cost if wrong: a staff member can remove a canned reply the owner liked; the owner re-types it, and the audit row shows who deleted it.
