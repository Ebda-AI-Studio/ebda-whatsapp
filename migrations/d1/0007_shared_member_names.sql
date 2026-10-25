-- Display names on the shared number must not collide (impersonation): a normalised key, unique among a number's active members.
-- The index holds it, so two joins at the same moment cannot both take one name.
ALTER TABLE shared_number_members ADD COLUMN name_key TEXT;
CREATE UNIQUE INDEX shared_member_name_unique ON shared_number_members (phone_number_id, name_key) WHERE status = 'active' AND name_key IS NOT NULL;
