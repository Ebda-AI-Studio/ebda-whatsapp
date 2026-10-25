-- Joining the shared platform number needs an active or trialing plan whose package includes it (`shared_number = 1`). Every existing
-- package, the included store package among them, keeps including it; an operator can switch it off for a package.
ALTER TABLE packages ADD COLUMN shared_number INTEGER NOT NULL DEFAULT 1 CHECK (shared_number IN (0, 1));
