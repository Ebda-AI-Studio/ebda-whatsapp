# Legal pages: publishing notes (Ebda Chat)

These texts were reviewed and approved by counsel (confirmed by Ahmad, 2026-11-19). Another team publishes them.

## Files and target URLs
| Source (ar / en) | Publish at |
|---|---|
| `ar/whatsapp-terms.md`, `en/whatsapp-terms.md` | https://ebda.app/legal/whatsapp-terms/ |
| `ar/whatsapp-privacy.md`, `en/whatsapp-privacy.md` | https://ebda.app/legal/whatsapp-privacy/ |
| `ar/whatsapp-dpa.md`, `en/whatsapp-dpa.md` | https://ebda.app/legal/whatsapp-dpa/ |

The data-deletion page is shared with other products and lives at https://ebda.app/legal/data-deletion/. The pages link to it; it is not written here.

Each page carries frontmatter (title, slug, lang, updated: 2026-11-09, version: 1.1) and the line "Arabic version prevails". Strip the frontmatter and the HTML comments when rendering; the comments are not visible text.

## Clauses marked pending legal review
None. Counsel approved the whole text (2026-11-19), so no clause carries a `PENDING LEGAL REVIEW` marker. If a future clause needs one, the Store's publish script shows it as visibly provisional.

## Also check before publishing
- Liability cap (fees paid in the 3 months before the event) and governing law/venue (Egyptian law, Cairo courts, 30-day negotiation, consumer-law carve-out) mirror the Ebda Store terms; keep them in sync.
- Wallet expiry (resolved 2026-10-25): the product does not expire wallet balances (no expiry exists in the billing code); only package AI credits end with their package period, and a cancelled account's balance is refundable for 12 months (WA-REFUND-1). Terms 6.4 says exactly that. A brief asked for "credits expire 12 months after top-up"; adding that would need code (a ledger `expire` entry per top-up) and a decision first.
- The Terms say the margin is currently 0% with notice before any change (from `docs/billing.md` and help 10).
- Facts not found in the sources and left generic: retention of operational logs, retention of message bodies while the account is active (stated as "as long as the account is active"), the legal entity details of Ebda AI Studio (entity pending), a registered address, any PDPL licence or approval for cross-border transfer, a data-protection contact separate from privacy@ebda.app, and the exact refund process in the app.
- The 72-hour breach notice and 30-day sub-processor notice are commitments from the brief; confirm operations can meet them.

## Version history
- `updated: 2026-11-03` (material): Terms section 9 bans alcohol, pork, paid-entry prize draws, mystery boxes sold for chance, fake reviews and fake scarcity (SHARIA-AUP-1, mirrors the Store acceptable-use policy v1.2); Arabic files name the product ابدأ شات and the studio ابدأ ستوديو; DPA and privacy only change the dates and names. The Store's vendored copy must be re-synced after this merges.
- `updated: 2026-11-09`, `version: 1.1` (**for counsel review**): the Arabic terms, privacy policy and DPA are rewritten clause by clause into formal legal Arabic (فصحى قانونية) with the same meaning, naming the product ابدأ شات and the studio ابدأ ستوديو للذكاء الاصطناعي in running text; the English files change only their front matter. The Store's vendored copy (`apps/marketing/legal-source`) carries the same files. `test/guards.test.ts` fails on colloquial markers (اللي، بتاع، بيتم، ده، دي، مش، عشان…) in any Arabic legal file, so a re-import cannot bring the colloquial text back.
