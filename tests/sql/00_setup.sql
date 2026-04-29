-- Setup: creates a fresh test user with deterministic data.
-- Idempotent — drops + recreates the test user every run.
\set ON_ERROR_STOP on

BEGIN;

DELETE FROM users WHERE phone_number = '__TEST__1234567890';

SELECT bootstrap_user('__TEST__1234567890', 'Test User') AS uid \gset

WITH
  cat_comida AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'comida' LIMIT 1),
  cat_super  AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'supermercado' LIMIT 1),
  cat_otros  AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'otros' LIMIT 1)
INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
SELECT :'uid'::uuid, 'expense', 2000, 'café del día 1', (SELECT id FROM cat_comida), DATE_TRUNC('month', CURRENT_DATE)::DATE + 0
UNION ALL SELECT :'uid'::uuid, 'expense', 2000, 'café del día 2', (SELECT id FROM cat_comida), DATE_TRUNC('month', CURRENT_DATE)::DATE + 1
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), DATE_TRUNC('month', CURRENT_DATE)::DATE + 2
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), DATE_TRUNC('month', CURRENT_DATE)::DATE + 2
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), DATE_TRUNC('month', CURRENT_DATE)::DATE + 2
UNION ALL SELECT :'uid'::uuid, 'expense', 15000, 'compra mensual', (SELECT id FROM cat_super), DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE + 5;

COMMIT;

\echo SETUP_UID=:uid
