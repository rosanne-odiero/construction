-- Lock two-step verification after repeated wrong TOTP or recovery codes (brief §7, §15 F).
ALTER TABLE users
  ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT users_mfa_failed_attempts_check CHECK (mfa_failed_attempts >= 0),
  ADD COLUMN mfa_locked_until timestamptz;
