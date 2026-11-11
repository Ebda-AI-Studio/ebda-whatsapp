---
name: Ebda Chat
description: Arabic-first three-pane WhatsApp inbox where the customer's order always sits beside the chat; night rail, cream ground, one brass-gold voice.
colors:
  night: "#0a0b0c"
  night-raised: "#1a1916"
  night-line: "#2c2a26"
  gold: "#b08d57"
  gold-ink: "#6f5530"
  gold-lift: "#cba873"
  cream: "#faf8f3"
  paper: "#ffffff"
  sand: "#f1e8d8"
  sand-selected: "#f6f0e4"
  ink: "#1b1a17"
  ink-soft: "#5f5a51"
  hairline: "#e6e0d4"
  on-night: "#efe9dd"
  on-night-soft: "#a9a396"
  ok-green: "#2f6b4a"
  warn-umber: "#8a4d12"
  bad-brick: "#9a3328"
typography:
  body:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
    fontFeature: "tnum"
  title:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.7
  total:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.7
  label:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  caption:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
  strip:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  pane-heading:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.7
rounded:
  focus: "6px"
  sm: "8px"
  field: "10px"
  md: "12px"
  lg: "14px"
  bubble: "16px"
  sheet: "18px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
components:
  button-primary:
    backgroundColor: "{colors.night}"
    textColor: "{colors.on-night}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 18px"
  button-gold:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.night}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 18px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 18px"
  button-danger:
    backgroundColor: "{colors.bad-brick}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "44px"
  chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "34px"
    padding: "0 12px"
  chip-selected:
    backgroundColor: "{colors.night}"
    textColor: "{colors.on-night}"
  bubble-in:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "9px 14px 6px"
  bubble-out:
    backgroundColor: "{colors.sand}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "9px 14px 6px"
  row-selected:
    backgroundColor: "{colors.sand-selected}"
    rounded: "10px"
    padding: "10px"
  unread-pill:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.night}"
    rounded: "{rounded.pill}"
    height: "22px"
  order-card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input-composer:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "10px 14px"
---

# Design System: Ebda Chat

## Overview

**Creative North Star: "The Counter With the Ledger Open"**

A shop counter where the customer is talking and their order slip lies open beside you. The screen is a warm cream working ground, white panes divided by warm hairlines, and a night rail at the inline-start edge carrying the gold doorway mark. Everything is quiet so that one thing can be loud: brass-gold marks the single thing that needs doing now (confirm the order, the unread count, the unseen COD dot).

It is Arabic-first and right-to-left: layout uses logical properties, mirrors directional motion, and customer text sets its own direction (`unicode-bidi: plaintext`). Readex Pro carries Arabic and Latin in one voice with tabular numerals so prices, times and counts align. Density is operator-grade: 44px targets, 10-14px radii, no decoration that does not carry status.

The signature is the brass rail of order stops (placed, confirmed, shipped, delivered) that fills gold as the order advances: the one piece of drawn structure on the screen.

**Key Characteristics:**
- Cream ground, white panes, night rail; one brass-gold accent used sparingly.
- Flat: hairlines and tonal sand/cream steps carry depth; shadow only on floating layers.
- Order progress drawn as structure, not a badge.
- Status (sent, read, failed, window closing) always visible in colour plus text.
- Colour never carries meaning alone; Arabic and English both complete.

## Colors

A warm-neutral field with one metallic accent and three muted status inks.

### Primary
- **Brass Gold** (#b08d57): the action that needs doing: Confirm, unread pill, unseen-COD dot, selected-avatar ring, rail fill, focus ring, search/composer focus border.
- **Gold Ink** (#6f5530): gold as text on light grounds (6.1:1 on white): order status, "open order" strip link, caret.
- **Lift Gold** (#cba873): gold on night: active rail item, toast action, text selection.

### Neutral
- **Night** (#0a0b0c): rail, selected chip, Send button, toast, drawer scrim base.
- **Night Raised** (#1a1916) / **Night Line** (#2c2a26): active rail tile, borders inside night.
- **Cream** (#faf8f3): app ground, chat pane, composer field.
- **Paper** (#ffffff): list pane, chat header, composer bar, incoming bubble, cards.
- **Warm Sand** (#f1e8d8): outgoing bubble. **Sand Selected** (#f6f0e4): selected row, open-order strip, notices, popover hover.
- **Ink** (#1b1a17) / **Soft Ink** (#5f5a51, 6.0:1 on cream): text.
- **Warm Hairline** (#e6e0d4): every 1px divider and border.
- **On Night** (#efe9dd) / **On Night Soft** (#a9a396): text on night.

### Status
- **Delivered Green** (#2f6b4a), **Window Umber** (#8a4d12, closing window), **Brick** (#9a3328, failed, refused, closed window, danger). Always paired with a word or icon.

### Named Rules
**The One Voice Rule.** Gold marks only what needs action or attention now. A screen with gold on decoration has spent its voice.
**The No Orange Rule.** No orange anywhere in Ebda's own UI; the gold is brass, not amber.
**The Gold Is Not Text Rule.** Gold on light grounds is a fill or ring; text in that role uses Gold Ink.

## Typography

**Display/Body/Label Font:** Readex Pro Variable (self-hosted via @fontsource-variable, system-ui fallback)

**Character:** one humanist Arabic-Latin family at weights 400/500/600; hierarchy comes from size and weight, never from a second face. Tabular numerals are on globally.

### Hierarchy
- **Title** (500, 18px): pane titles. Section heads in the orders pane are 16px/500.
- **Total** (600, 17px): order total.
- **Body** (400, 15px, 1.55): messages, rows, buttons (buttons 500).
- **Label** (400, 13px): secondary previews, field labels, chips.
- **Caption** (400, 12px): timestamps, message status, rail-stop labels, window time.

### Named Rules
**The Tabular Rule.** Numerals are tabular everywhere (`font-variant-numeric: tabular-nums` on root).
**The Own-Direction Rule.** Customer-authored text uses `dir="auto"` / `unicode-bidi: plaintext` and `text-align: start`; never impose the UI direction on it.
**The No Letter Motion Rule.** No per-letter animation (breaks Arabic joining).

## Layout

Desktop (>=1200px): four grid columns: 72px rail, 340px list, fluid chat, 344px orders. Tablet (820-1199px): orders become a drawer from the inline-end edge over a 28% night scrim. Phone (<820px): one pane at a time (list or chat), rail hidden, an order strip above the chat opens the orders as a bottom sheet (max 82vh, 18px top corners). Everything uses logical properties so RTL is the default and LTR mirrors. Spacing is a loose 4/6/8/10/12/16/20px rhythm; thread padding clamps 16-36px. Touch and phone raise chips and search to 44px+.

## Elevation & Depth

Flat by default. Depth comes from tonal steps (cream ground, white panes, sand selection) and 1px warm hairlines. Shadow exists only on the floating layer and never at rest.

### Shadow Vocabulary
- **Popover** (`0 18px 44px rgba(10,11,12,0.14)`): quick-reply and template popovers.
- **Toast** (`0 16px 40px rgba(10,11,12,0.24)`): night toast with undo.
- **Drawer** (`0 0 48px rgba(10,11,12,0.18)`): the tablet orders drawer.

### Named Rules
**The Floating-Only Rule.** If it is not floating above the page, it has no shadow.
**The No Gradient Rule.** No gradients, no glass. The single exception is the mask fade at the quick-reply strip's scroll edge (it hides overflow, it is not decoration).

## Shapes

Soft but disciplined: 8px (small), 10-12px (inputs, buttons, rows), 14px (order card), 16px bubbles with a 4px tail corner on the sender's side (`border-start-start` incoming, `border-start-end` outgoing), full pills for chips, unread count and tags, circles for avatars (42px). Focus is a 2px gold outline with 2px offset.

## Components

### Buttons
- **Shape:** 12px radius, 44px minimum height, 500 weight, 18px inline padding.
- **Night (primary Send):** Night fill, On Night text; collapses to a 44px square icon on phone.
- **Gold:** Brass fill, Night text; only the one needed action (Confirm order, open-window template). Hover lightens slightly.
- **Outline / Ghost:** white or transparent with hairline; used for Refuse and secondary actions. **Danger:** Brick fill, white text, shown only in the refuse confirmation.

### Chips
Pill, 34px (44px on touch), hairline on white. Selected = Night fill with On Night text. Quick replies reuse chips in a horizontally scrolling strip with an edge fade mask.

### Conversation Row
- 42px avatar, name, one-line preview, time, gold unread pill. Selected = Sand Selected tint plus a gold ring around the avatar (2px paper gap, 2px gold). Unseen COD = an 11px gold dot at the avatar's inline-end corner. No coloured edge stripe on rows.

### Bubbles
Incoming: white with hairline. Outgoing: Warm Sand, no border. Meta line (time, status) at 12px Soft Ink; failed turns Brick with an underlined retry action. Enter with a 220ms rise.

### Order Card and Brass Rail (signature)
White card, 14px radius, 1px hairline, 16px padding: order number, status in Gold Ink (Brick for refused/cancelled, Green for delivered), total, items, payment, actions grid (Confirm gold + Refuse outline). The rail is four dots on a 2px hairline track; the gold fill grows to `--fill` over 600ms; done dots are gold with a paper inner ring; a halted stop is a Brick outline.

### Inputs
Composer textarea: cream field, hairline, 12px radius, 44px min, border turns gold and field turns white on focus. Search: 10px radius, 42px, border gold on focus-within.

### Rail
72px Night column: gold doorway mark on top, 56px nav tiles with icon and 12px label in On Night Soft; current = Night Raised tile with Lift Gold.

### Notices and Toast
Notices are Sand Selected strips (offline = pale brick tint with Brick text). Toast: Night, On Night, 12px radius, ghost action in Lift Gold.

## Do's and Don'ts

### Do:
- **Do** spend gold only on the one needed action, unread count, unseen-COD dot, selection ring and the rail fill.
- **Do** keep every target 44px on touch and every status as colour plus word.
- **Do** use logical properties and mirror directional motion in RTL.
- **Do** mark sample data visibly (the sample badge) until live data lands.
- **Do** respect `prefers-reduced-motion` (all animation and transitions are cut).

### Don't:
- **Don't** add orange, gradients (beyond the quick-reply fade mask), glass or resting shadows.
- **Don't** put a coloured stripe or border-inline-start accent on rows; selection is tint plus avatar ring.
- **Don't** use gold as text colour on light grounds; use Gold Ink.
- **Don't** animate text per letter or impose the UI direction on customer content.
- **Don't** hard-code "Ebda" in the brand-neutral core; white-label copies reuse it.
