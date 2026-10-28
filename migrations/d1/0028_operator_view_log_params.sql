-- Final review I4 (support): the view-as log keeps the ROUTED pattern (`/stores/:storeId/contacts/:waId/orders`) in `route` and the concrete route params as KEYED HASHES in
-- `params` (JSON {name: 32 hex}, HMAC under ERASURE_HMAC_KEY, the waId hash equals the erasure subject hash). The raw path is never stored: a regex mask missed `%2B2010...`,
-- Arabic-Indic digits and `20-100-...`. Rows written before this keep their old masked route and a NULL params (the table is append-only).
ALTER TABLE operator_view_log ADD COLUMN params TEXT;
