-- The Meta business portfolio that owns the WhatsApp Business Account, as Embedded Signup reported it (session message `business_id`).
-- Needed to create a product catalog (POST /{business_id}/owned_product_catalogs). Null for numbers connected before this column.
ALTER TABLE waba_credentials ADD COLUMN business_id TEXT;
