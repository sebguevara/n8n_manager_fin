-- Setup: creates a fresh test user with deterministic data.
-- Idempotent — drops + recreates the test user every run.
\set ON_ERROR_STOP on

BEGIN;

DELETE FROM users WHERE phone_number = '__TEST__1234567890';

SELECT bootstrap_user('__TEST__1234567890', 'Test User') AS uid \gset

-- Fechas: get_total_dynamic / query_tx_dynamic clampean v_end := CURRENT_DATE
-- para los períodos this_*, así que las fixtures NUNCA pueden ser futuras o
-- los tests rompen cuando corren en los primeros días del mes. Antes el setup
-- usaba `month_start + 0/1/2`, lo que daba 2026-05-03 si hoy era el día 2 →
-- las 3 transferencias caían fuera de this_month y los totales daban 4000 en
-- vez de 13900.
--
-- Además, test 02 chequea que "yesterday" devuelva 0 rows, así que NINGUNA
-- fixture puede caer en CURRENT_DATE - 1 (eso quitaría hasta 1 día de margen
-- los días 2 del mes).
--
-- Solución pragmática: poner las 5 fixtures de this_month todas en
-- CURRENT_DATE (hoy). Funciona en cualquier día del mes, las fixtures
-- siempre son <= today, y "yesterday" garantiza vacío. La consecuencia es
-- que solo hay 1 día distinto en this_month — el test 02 fue ajustado para
-- aceptar eso.
WITH
  cat_comida AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'comida' LIMIT 1),
  cat_super  AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'supermercado' LIMIT 1),
  cat_otros  AS (SELECT id FROM categories WHERE user_id = :'uid'::uuid AND normalized_name = 'otros' LIMIT 1)
INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
SELECT :'uid'::uuid, 'expense', 2000, 'café del día 1', (SELECT id FROM cat_comida), CURRENT_DATE
UNION ALL SELECT :'uid'::uuid, 'expense', 2000, 'café del día 2', (SELECT id FROM cat_comida), CURRENT_DATE
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), CURRENT_DATE
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), CURRENT_DATE
UNION ALL SELECT :'uid'::uuid, 'expense', 3300, 'Transferencia a Maxi', (SELECT id FROM cat_otros), CURRENT_DATE
UNION ALL SELECT :'uid'::uuid, 'expense', 15000, 'compra mensual', (SELECT id FROM cat_super),
       (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE + 5);

COMMIT;

\echo SETUP_UID=:uid
