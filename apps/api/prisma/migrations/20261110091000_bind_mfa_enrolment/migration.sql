-- A pending TOTP enrolment can only be confirmed by the session that started it, so a password-only
-- session can't finish an enrolment begun before the account gained another factor.
ALTER TABLE users ADD COLUMN mfa_pending_session_id uuid;
UPDATE users SET mfa_pending = NULL, mfa_pending_until = NULL WHERE mfa_pending IS NOT NULL;
