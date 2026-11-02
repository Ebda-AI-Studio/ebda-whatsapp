# Ruling FDN-TEXT-1

**Decision:** this repo adopts the foundation's `phone`, `buyer` and `brand` modules now, but keeps `src/core/text-normalise.ts` (NFKC, strips punctuation, does not fold ئ ؤ ک) until the search step. The foundation's `text` module (`foldArabic`, the Store's fold, canonical) is vendored but unused here.

**Evidence:** switching the fold changes what the search index stores, so it needs the Durable Object re-index migration (a controller-assigned DO version), which is a behaviour change and not part of this no-behaviour-change adoption.

**Cost if wrong:** until the re-index step ships, a WhatsApp search for "مسئول" does not find "مسؤول"; nothing regresses.
