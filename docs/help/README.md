# Ebda WhatsApp merchant help guides

Content for help.ebda.app (plan task 8.5). One file per topic, same slug in `ar/` (Egyptian Arabic first) and `en/` (faithful version).

| # | Slug | Topic |
|---|---|---|
| 01 | verify-your-business-on-meta | Meta Business Verification in Egypt (commercial register + tax card) |
| 02 | connect-your-own-number | Embedded Signup, own number, display name, Meta bills your card (WA-FUND-1) |
| 03 | use-the-shared-number | Shared number add-on, "on behalf of your store", wallet, free-reply true-up (WA-SHARED-1, WA-SHARED-FREE-1) |
| 04 | templates-and-the-24-hour-window | Templates and the 24 h window |
| 05 | cod-confirmations | COD confirmations |
| 06 | instapay-orders-in-whatsapp | InstaPay orders (PAY-INSTAPAY-1) |
| 07 | ai-agent | AI agent, handoff, AI credits |
| 08 | campaigns-and-opt-out | Campaigns, opt-out, limits, error 131049 |
| 09 | wallet-top-ups-and-refunds | Wallet, top-ups, overdraft, refunds (WA-TOPUP-FEE-1, WA-OVERDRAFT-1, WA-REFUND-1) |
| 10 | meta-fees-explained | Per-category Meta fees, who pays (WA-BILL-1, WA-MARGIN-1) |

## Publishing note (for the Store session's `apps/help`)
- Files are plain Markdown with relative links between guides (`NN-slug.md`); they are published as the **Ebda WhatsApp** section of the suite help site: Arabic `https://help.ebda.app/whatsapp/<slug>/`, English `https://help.ebda.app/en/whatsapp/<slug>/` (Store repo `apps/help` imports them as `content/{ar,en}/whatsapp/<slug>.mdx`, frontmatter `section: "Ebda WhatsApp"`). Arabic is the default locale; render RTL. The inbox links to exactly this shape (`helpUrl` in `web/brands/ebda/brand.ts`), where the slug is the file name without its `NN-` prefix (a test reads this folder, so a renamed guide fails it).
- Each guide ends with "Last checked" (2026-10-25). Re-check every guide against Meta's current screens before launch and when Meta changes its flows; update the date.
- Copy rules: product name "Ebda WhatsApp", company "Ebda AI Studio"; no infrastructure provider names. Undecided values (package prices, add-on price) are deliberately left to "set by the Ebda AI Studio team".
- Guide 09 refund text is marked "subject to final terms of service": align it with the terms before launch (legal check pending). Margin is stated as 0% "for now" (WA-MARGIN-1 is operator-editable); update guides 03 and 10 if it changes.
- No screenshots are included (none of this product's screens are final); add them in the help app once the onboarding UI is audited.
