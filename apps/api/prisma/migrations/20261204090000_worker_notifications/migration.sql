BEGIN;

CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  sms boolean NOT NULL DEFAULT false,
  whatsapp boolean NOT NULL DEFAULT false,
  locale varchar(2) NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'sw')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_self ON notification_preferences
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE ALL ON notification_preferences FROM pmb_app;
    GRANT SELECT, INSERT, UPDATE ON notification_preferences TO pmb_app;
  END IF;
END $$;

COMMIT;
