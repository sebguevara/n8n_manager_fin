-- Cleanup: remove test user and all its data (cascades)
\set ON_ERROR_STOP on
DELETE FROM users WHERE phone_number = '__TEST__1234567890';
\echo CLEANUP_OK
