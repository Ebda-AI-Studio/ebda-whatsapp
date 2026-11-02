# Legal pages: publishing notes (Ebda Chat)

**These are drafts. They have NOT been reviewed by a lawyer.** Another team publishes them; do not present them as lawyer-reviewed.

## Files and target URLs
| Source (ar / en) | Publish at |
|---|---|
| `ar/whatsapp-terms.md`, `en/whatsapp-terms.md` | https://ebda.app/legal/whatsapp-terms/ |
| `ar/whatsapp-privacy.md`, `en/whatsapp-privacy.md` | https://ebda.app/legal/whatsapp-privacy/ |
| `ar/whatsapp-dpa.md`, `en/whatsapp-dpa.md` | https://ebda.app/legal/whatsapp-dpa/ |

The data-deletion page is shared with other products and lives at https://ebda.app/legal/data-deletion/. The pages link to it; it is not written here.

Each page carries frontmatter (title, slug, lang, updated: 2026-10-25) and the line "Arabic version prevails". Strip the frontmatter and the HTML comments when rendering; the comments are not visible text.

## Clauses marked pending legal review
- Terms 6.5 Refunds (`<!-- PENDING LEGAL REVIEW: refunds -->`): the 12-month refundable window after cancellation, 50 EGP minimum, non-refundable list. Taken from the help article, which itself says "subject to the final terms".
- Terms 6.6 VAT (`<!-- PENDING LEGAL REVIEW: VAT -->`): launch VAT rate is 0 and the decision (Q5) is still open in `docs/billing.md`; the clause only says VAT is added as a separate line where it applies.

## Also check before publishing
- Liability cap (fees paid in the 3 months before the event) and governing law/venue (Egyptian law, Cairo courts, 30-day negotiation, consumer-law carve-out) mirror the Ebda Store terms; keep them in sync.
- Wallet expiry (resolved 2026-10-25): the product does not expire wallet balances (no expiry exists in the billing code); only package AI credits end with their package period, and a cancelled account's balance is refundable for 12 months (WA-REFUND-1). Terms 6.4 says exactly that. A brief asked for "credits expire 12 months after top-up"; adding that would need code (a ledger `expire` entry per top-up) and a decision first.
- The Terms say the margin is currently 0% with notice before any change (from `docs/billing.md` and help 10).
- Facts not found in the sources and left generic: retention of operational logs, retention of message bodies while the account is active (stated as "as long as the account is active"), the legal entity details of Ebda AI Studio (entity pending), a registered address, any PDPL licence or approval for cross-border transfer, a data-protection contact separate from privacy@ebda.app, and the exact refund process in the app.
- The 72-hour breach notice and 30-day sub-processor notice are commitments from the brief; confirm operations can meet them.
