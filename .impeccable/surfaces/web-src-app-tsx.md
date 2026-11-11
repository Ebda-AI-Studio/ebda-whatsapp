---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: []
---

# Surface: Ebda Chat inbox (web app)

Mode: Operate. Users: merchants and 1–3 staff on phones; marketing-client teams at desks (both equally). Job: answer customers fast and confirm or refuse COD orders with the order in view. Constraints: Arabic-first RTL, Egyptian Arabic, English complete; Ebda brand pack; no orange; WCAG 2.2 AA; 44 px targets; sample data labelled until the Store RPC lands.

## Direction contract
THESIS: The inbox where the customer's order is always beside the chat. Refuses the category default of a chat app with a CRM sidebar bolted on: the order panel is a first-class pane, and order progress is the screen's one piece of drawn structure.
OWN-WORLD: Cream #FAF8F3 working ground, white panes, Night #0A0B0C navigation rail with a gold doorway mark, Gold #B08D57 for the one thing that needs action (primary order action, unread count, active row edge), Lift #CBA873 on night; 1 px warm hairlines #E6E0D4; IBM Plex Sans Arabic (Arabic + Latin) with tabular numerals; 10–14 px radii; no gradients, no glass, no shadows except the floating command/drawer layer.
STORY: The visitor sees who wrote, what they want and what they ordered without clicking; replies or confirms in one action; trusts that status (sent, read, failed, window closing) is always visible.
FIRST VIEWPORT: Desktop 1440: night rail at the inline-start edge (right in RTL, 72 px); chat list pane 330 px (title, filter chips All/Unread/Mine/Unassigned, search, rows with avatar, name, preview, time, gold unread pill, active row gold inline-start edge); chat pane fluid (header with name, window time left, assignee; day separator; bubbles in = white with hairline, out = warm sand #F1E8D8; composer with quick replies, template, input, night Send); order pane 340 px (customer order count and delivery record, current order card with total, items, payment, the brass rail of stops, gold Confirm + outline Refuse; older orders as compact rows). Phone 390: one pane at a time (list → chat), order card collapses to a strip above the chat that opens a bottom sheet.
FORM: Three-pane desk, position 1 on the ordered list; signature move: order state drawn as a brass rail of stops (placed → confirmed → shipped → delivered) that fills gold as the order advances, and a COD refusal or new message keeps its row's gold edge lit until opened (kept from the gate-board challenger). seed:7cb7563cd9d4e4bc
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
