# Ruling WA-CAT-2

**Decision:** One source per WhatsApp-linked catalogue: Ebda Chat's Batch API sync (`items_batch`) is the only writer. If the merchant also points Meta at the Google-format feed URL (or any scheduled feed) for the same catalogue, items would be written by two sources under possibly different ids and duplicate. The admin and the merchant help say so; the Bot screen shows that the sync is ours. A catalogue used for ads may be a different catalogue.

**Evidence (2026-11-14):** Meta allows one catalogue per WhatsApp account hierarchy (upload-inventory page) and an item id is unique inside a catalogue: two sources with different id schemes produce duplicate products; with the same scheme the later writer wins on every field. Documented in `docs/store-link.md` and `docs/help/*/15-your-products-on-whatsapp.md`.

**Cost if wrong:** A merchant who adds a second feed sees duplicate or flip-flopping products in WhatsApp until the feed is removed; the nightly pass would not fix it (it does not own the other source's items unless their ids are ours).
