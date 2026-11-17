# Ruling CHAT-AGENT-7

**Decision (2026-11-14, independent review of ebda-whatsapp pr 79 I1, I2, I3):**

1. **Shopper-typed text is untrusted, including the profile.** First name and address fields come from what the shopper typed at Store checkout. They are rendered inside a `<customer_profile>` fence (named in the security boundary), stripped of links, e-mail-like tokens, currency amounts, angle brackets and control characters, length-capped, and the name is letters only. They are NEVER added to what the reply guard trusts; only the Store's own past-order totals are (`profilePrices`). A planted link or amount cannot be repeated in a reply.
2. **The handoff dedupe marker lives on the handoff row** (`agent_handoffs.notified_at`, migration v42), not as `handoff_notice:<phone>` in `agent_state` (backed up, not swept per contact). It is erased by `wa_id` with the contact and disappears when the handoff window elapses, so a later handoff pages again.
3. **Franco detection needs an Arabic chat numeral standing for a letter inside a word** (leading before a vowel, or next to a vowel, word of 4+ characters) or a lexicon word; units, ordinals, times, sizes and `b2b`-style tokens are English, and `mesh` counts only with a second weak word.

**Evidence:** `test/chat-agent-context.test.ts` (planted URL/amount refused; amount in words survives sanitising and is still refused, mutation: re-adding the customer block to the trusted text turns it red), `test/handoff-notify.test.ts` (no phone-keyed agent_state row; erasure removes the marker; mutation: dropping the `notified_at` write turns it red), `test/franco.test.ts` (15 English negatives, new positives; mutation: the old digit rule turns it red).

**Cost if wrong:** a shopper's own address notes are shortened or lose a link-like token (the model asks again); an unusual Franco spelling with the numeral glued to consonants ("m3") is read as English and the shopper gets one English acknowledgement; a handoff opened after a staff reply notifies once more than before.
