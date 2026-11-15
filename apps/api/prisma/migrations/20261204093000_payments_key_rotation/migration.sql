-- Key rotation for the D4.2 payments ciphertexts (ARCHITECTURE §4.17 and §4.18, D-151,
-- docs/OPERATIONS.md "Key rotation"). `keys:rotate rewrap`, connected as the schema owner,
-- re-encrypts every field ciphertext not on the active key; the payments guards refused any change
-- to these columns (immutable evidence, versioned settings, retire-only routes). As in
-- 20261202090000_key_rotation, each guard now runs on INSERT as before and on UPDATE unless the
-- update is a re-encryption by the owner: only that ciphertext column changes, both values are
-- field ciphertexts and the key version differs (`app.is_field_rewrap`). Every other change still
-- meets the original guard. The tables' tenant policies already let the owner update in a
-- company's context; the restrictive staff-only policies pass (no portal user is set).
-- Cached Daraja OAuth tokens in Valkey are also sealed; one that no longer opens is a cache miss.
BEGIN;

-- Settings: five write-only credentials (associated data names the company as the row).
DROP TRIGGER payment_settings_guard ON "payment_settings";
CREATE TRIGGER payment_settings_guard BEFORE INSERT ON "payment_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_settings();
CREATE TRIGGER payment_settings_guard_update BEFORE UPDATE ON "payment_settings"
  FOR EACH ROW
  WHEN (NOT (
    app.is_field_rewrap(to_jsonb(OLD) - 'consumer_key_enc', to_jsonb(NEW) - 'consumer_key_enc',
      OLD.consumer_key_enc, NEW.consumer_key_enc)
    OR app.is_field_rewrap(to_jsonb(OLD) - 'consumer_secret_enc',
      to_jsonb(NEW) - 'consumer_secret_enc', OLD.consumer_secret_enc, NEW.consumer_secret_enc)
    OR app.is_field_rewrap(to_jsonb(OLD) - 'initiator_name_enc',
      to_jsonb(NEW) - 'initiator_name_enc', OLD.initiator_name_enc, NEW.initiator_name_enc)
    OR app.is_field_rewrap(to_jsonb(OLD) - 'initiator_password_enc',
      to_jsonb(NEW) - 'initiator_password_enc', OLD.initiator_password_enc,
      NEW.initiator_password_enc)
    OR app.is_field_rewrap(to_jsonb(OLD) - 'passkey_enc', to_jsonb(NEW) - 'passkey_enc',
      OLD.passkey_enc, NEW.passkey_enc)
  ))
  EXECUTE FUNCTION app.guard_payment_settings();

-- Callback routes: active or retired, the sealed token is otherwise never rewritten.
DROP TRIGGER payment_callback_route_guard ON "payment_callback_routes";
CREATE TRIGGER payment_callback_route_guard BEFORE INSERT ON "payment_callback_routes"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_callback_route();
CREATE TRIGGER payment_callback_route_guard_update BEFORE UPDATE ON "payment_callback_routes"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'token_enc', to_jsonb(NEW) - 'token_enc', OLD.token_enc, NEW.token_enc
  ))
  EXECUTE FUNCTION app.guard_payment_callback_route();

-- Requests: the recipient's phone number.
DROP TRIGGER payment_request_guard ON "payment_requests";
CREATE TRIGGER payment_request_guard BEFORE INSERT ON "payment_requests"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_request();
CREATE TRIGGER payment_request_guard_update BEFORE UPDATE ON "payment_requests"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'msisdn_enc', to_jsonb(NEW) - 'msisdn_enc', OLD.msisdn_enc, NEW.msisdn_enc
  ))
  EXECUTE FUNCTION app.guard_payment_request();

-- Callback inbox: the raw body (received evidence).
DROP TRIGGER payment_callback_guard ON "payment_callback_inbox";
CREATE TRIGGER payment_callback_guard BEFORE INSERT ON "payment_callback_inbox"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_callback();
CREATE TRIGGER payment_callback_guard_update BEFORE UPDATE ON "payment_callback_inbox"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'body_enc', to_jsonb(NEW) - 'body_enc', OLD.body_enc, NEW.body_enc
  ))
  EXECUTE FUNCTION app.guard_payment_callback();

COMMIT;
