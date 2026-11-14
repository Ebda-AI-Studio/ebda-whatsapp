# Ebda Chat merchant help guides

Content for help.ebda.app (plan task 8.5). One file per topic, same slug in `ar/` (Egyptian Arabic first) and `en/` (faithful version).

| # | Slug | Topic |
|---|---|---|
| 01 | verify-your-business-on-meta | Meta Business Verification in Egypt (commercial register + tax card) |
| 02 | connect-your-own-number | Embedded Signup, own number, display name, Meta bills your card (WA-FUND-1) |
| 03 | use-the-shared-number | Shared number add-on, "on behalf of your store", wallet, free-reply true-up (WA-SHARED-1, WA-SHARED-FREE-1) |
| 04 | templates-and-the-24-hour-window | The 24 h window, the Templates screen (starter set on connect, create and submit, edit, delete), Meta's limits, shared-number stores (matches the real screen, 2026-11-14) |
| 05 | cod-confirmations | COD confirmations |
| 06 | instapay-orders-in-whatsapp | InstaPay orders (PAY-INSTAPAY-1) |
| 07 | ai-agent | AI agent, handoff, AI credits |
| 08 | campaigns-and-opt-out | Campaigns, opt-out, limits, error 131049 |
| 09 | wallet-top-ups-and-refunds | Wallet, top-ups, overdraft, refunds (WA-TOPUP-FEE-1, WA-OVERDRAFT-1, WA-REFUND-1) |
| 10 | meta-fees-explained | Per-category Meta fees, who pays (WA-BILL-1, WA-MARGIN-1) |
| 11 | service-menu-hours-and-location | The bot's service menu, opening hours with the away message, and sending your location |
| 12 | delete-your-workspace | Owner-initiated workspace deletion, the 14-day wait, what is kept (OFFBOARD-1) |
| 13 | your-customers-data | Message retention, downloading one customer's data, renaming, merging numbers (B4, B5, M-175) |
| 14 | team-members-and-seats | Package seats (owner included), giving and removing a seat, what a downgrade does (WA-SEATS-1) |

## Front matter (capability links)
Each guide starts with a front-matter block listing the capabilities it documents, `id@version` (the registry is `capabilities/*.capability.json`):

```
---
capabilities:
  - packages.list-checkout@1
---
```

`capabilities` is the only key; `appPath` is left out on purpose because the help site builds app links against the Store host. Bump the version here when a capability's `version` changes (`help-stale`). The guard (`test/capability-registry.test.ts`) checks the sources at PR time; `scripts/help-publication-lag.mjs` (nightly, `help-publication-lag` job) proves the Store import published them within 48 hours.

## Publishing note (for the Store session's `apps/help`)
- Files are plain Markdown with relative links between guides (`NN-slug.md`); they are published as the **Ebda Chat** section of the suite help site: Arabic `https://help.ebda.app/whatsapp/<slug>/`, English `https://help.ebda.app/en/whatsapp/<slug>/` (Store repo `apps/help` imports them as `content/{ar,en}/whatsapp/<slug>.mdx`, frontmatter `section: "Ebda Chat"`). Arabic is the default locale; render RTL. The inbox links to exactly this shape (`helpUrl` in `web/brands/ebda/brand.ts`), where the slug is the file name without its `NN-` prefix (a test reads this folder, so a renamed guide fails it).
- Guides 04, 16 and 17 (and every guide the capability help guard knows) start with front matter: a `capabilities:` block list of `<id>@<version>` and an `appPath`. The Store import (`import-wa-help.mjs`) must drop it before publishing.
- Each guide ends with "Last checked" (2026-10-25). Re-check every guide against Meta's current screens before launch and when Meta changes its flows; update the date.
- Copy rules: product name "Ebda Chat", company "Ebda AI Studio"; no infrastructure provider names. Undecided values (package prices, add-on price) are deliberately left to "set by the Ebda AI Studio team".
- Guide 09 refund text is marked "subject to final terms of service": align it with the terms before launch (legal check pending). Margin is stated as 0% "for now" (WA-MARGIN-1 is operator-editable); update guides 03 and 10 if it changes.
- No screenshots are included (none of this product's screens are final); add them in the help app once the onboarding UI is audited.
| 16 | write-and-submit-a-template | Create a template on the Templates page: type, variables with examples, header/footer/buttons, Meta's limits, the irreversible confirm, shared-number request |
| 17 | template-review-and-rejections | Statuses, reading a rejection in plain words, edit and resubmit (24 h / 10 per 30 days), delete (30-day name rule), recategorisation |
| 15 | your-products-on-whatsapp | Your Ebda Store products as a shop in WhatsApp: the shop button, product cards from the AI agent, carts that become orders, what is left out and why, one source only (WA-CAT-1..5) |
