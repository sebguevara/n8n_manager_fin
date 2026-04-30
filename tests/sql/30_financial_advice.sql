-- Test: compute_financial_advice (asesor financiero)
-- Cubre los 5 modos + edge cases. Inyecta ingresos/gastos extras
-- en una transacción que se ROLLBACKea al final, así no contamina
-- los datos del setup original.

\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('test.uid', :'uid', false);

-- Datos extra para tener historial completo:
--   last_month: 800k income + 200k extra expense (sumado a los 15k del setup = 215k)
--   this_month: 800k income (mes actual; los gastos ya vienen del setup = 13,900)
WITH
  cat_otros AS (SELECT id FROM categories
                 WHERE user_id = current_setting('test.uid')::uuid
                   AND normalized_name = 'otros' LIMIT 1)
INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
VALUES
    (current_setting('test.uid')::uuid, 'income',  800000, 'sueldo lm',
        (SELECT id FROM cat_otros),
        (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month'))::DATE + 1),
    (current_setting('test.uid')::uuid, 'expense', 200000, 'extra lm',
        (SELECT id FROM cat_otros),
        (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month'))::DATE + 10),
    (current_setting('test.uid')::uuid, 'income',  800000, 'sueldo tm',
        (SELECT id FROM cat_otros),
        (DATE_TRUNC('month', CURRENT_DATE))::DATE + 1);

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_eps NUMERIC := 0.01;  -- tolerancia para floats
BEGIN
    -- =============================================================
    -- 1. time_to_goal con monthly_saving_override (caso del usuario)
    --    "moto de 4M, ahorro 600k/mes" → 6.67 meses
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        4000000::NUMERIC,        -- goal_amount
        600000::NUMERIC,         -- monthly_saving_override
        NULL, NULL, 1, 0
    );
    IF r.mode <> 'time_to_goal' THEN
        RAISE EXCEPTION '[time_to_goal override] mode esperado time_to_goal, got %', r.mode;
    END IF;
    IF ABS(r.monthly_saving - 600000) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal override] monthly_saving esperado 600000, got %', r.monthly_saving;
    END IF;
    IF ABS(r.months_to_goal - 6.67) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal override] months_to_goal esperado 6.67, got %', r.months_to_goal;
    END IF;
    IF r.target_date IS NULL THEN
        RAISE EXCEPTION '[time_to_goal override] target_date no debería ser NULL';
    END IF;
    IF r.target_date <= CURRENT_DATE THEN
        RAISE EXCEPTION '[time_to_goal override] target_date debería estar en el futuro, got %', r.target_date;
    END IF;

    -- =============================================================
    -- 2. time_to_goal sin override → usa promedio histórico
    --    last_month: income 800k - expense 215k (15k setup + 200k extra) = saving 585k
    --    goal 1.170M / 585k = 2.0 meses
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        1170000::NUMERIC,
        NULL, NULL, NULL, 1, 0
    );
    IF ABS(r.avg_monthly_income - 800000) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal hist] avg_monthly_income esperado 800000, got %', r.avg_monthly_income;
    END IF;
    IF ABS(r.avg_monthly_expense - 215000) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal hist] avg_monthly_expense esperado 215000, got %', r.avg_monthly_expense;
    END IF;
    IF ABS(r.monthly_saving - 585000) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal hist] monthly_saving esperado 585000, got %', r.monthly_saving;
    END IF;
    IF ABS(r.months_to_goal - 2.0) > v_eps THEN
        RAISE EXCEPTION '[time_to_goal hist] months_to_goal esperado 2.0, got %', r.months_to_goal;
    END IF;
    IF r.months_used <> 1 THEN
        RAISE EXCEPTION '[time_to_goal hist] months_used esperado 1, got %', r.months_used;
    END IF;

    -- =============================================================
    -- 3. time_to_goal con saving=0 (no estás ahorrando)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        500000::NUMERIC,
        0::NUMERIC,             -- saving override = 0 → no podés
        NULL, NULL, 1, 0
    );
    IF r.months_to_goal IS NOT NULL THEN
        RAISE EXCEPTION '[time_to_goal zero saving] months_to_goal debe ser NULL, got %', r.months_to_goal;
    END IF;
    IF r.note NOT LIKE '%no estás ahorrando%' THEN
        RAISE EXCEPTION '[time_to_goal zero saving] note debería mencionar "no estás ahorrando", got "%"', r.note;
    END IF;

    -- =============================================================
    -- 4. time_to_goal con saving negativo (gastás más de lo que cobrás)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        500000::NUMERIC,
        NULL,
        500000::NUMERIC,          -- income override
        700000::NUMERIC,          -- expense override (gastás más)
        1, 0
    );
    IF r.months_to_goal IS NOT NULL THEN
        RAISE EXCEPTION '[time_to_goal negative saving] months_to_goal debe ser NULL, got %', r.months_to_goal;
    END IF;
    IF r.monthly_saving >= 0 THEN
        RAISE EXCEPTION '[time_to_goal negative saving] monthly_saving debería ser negativo, got %', r.monthly_saving;
    END IF;

    -- =============================================================
    -- 5. time_to_goal sin goal_amount (param inválido)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        NULL,                    -- sin goal_amount
        600000::NUMERIC,
        NULL, NULL, 1, 0
    );
    IF r.months_to_goal IS NOT NULL THEN
        RAISE EXCEPTION '[time_to_goal no goal] months_to_goal debe ser NULL';
    END IF;
    IF r.note NOT LIKE '%goal_amount%' THEN
        RAISE EXCEPTION '[time_to_goal no goal] note debería mencionar goal_amount';
    END IF;

    -- =============================================================
    -- 6. affordability TRUE (saving cubre el gasto)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'affordability',
        400000::NUMERIC,         -- gasto a evaluar
        600000::NUMERIC,
        NULL, NULL, 1, 0
    );
    IF r.affordable IS NOT TRUE THEN
        RAISE EXCEPTION '[affordability true] affordable esperado TRUE, got %', r.affordable;
    END IF;
    IF r.note NOT LIKE '%cubre%' THEN
        RAISE EXCEPTION '[affordability true] note debería mencionar "cubre", got "%"', r.note;
    END IF;

    -- =============================================================
    -- 7. affordability FALSE (saving no cubre, requiere meses extra)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'affordability',
        600000::NUMERIC,
        300000::NUMERIC,
        NULL, NULL, 1, 0
    );
    IF r.affordable IS NOT FALSE THEN
        RAISE EXCEPTION '[affordability false] affordable esperado FALSE, got %', r.affordable;
    END IF;
    IF ABS(r.months_to_goal - 2.0) > v_eps THEN
        RAISE EXCEPTION '[affordability false] months_to_goal esperado 2.0 (proyección), got %', r.months_to_goal;
    END IF;

    -- =============================================================
    -- 8. affordability sin saving (te hunde el mes)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'affordability',
        100000::NUMERIC,
        0::NUMERIC,              -- saving=0
        NULL, NULL, 1, 0
    );
    IF r.affordable IS NOT FALSE THEN
        RAISE EXCEPTION '[affordability zero] affordable debe ser FALSE';
    END IF;
    IF r.note NOT LIKE '%hunde%' AND r.note NOT LIKE '%0 o negativo%' THEN
        RAISE EXCEPTION '[affordability zero] note debería avisar del problema, got "%"', r.note;
    END IF;

    -- =============================================================
    -- 9. savings_capacity (sin goal)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'savings_capacity',
        NULL, NULL, NULL, NULL, 1, 0
    );
    IF ABS(r.avg_monthly_income - 800000) > v_eps THEN
        RAISE EXCEPTION '[savings_capacity] avg_monthly_income esperado 800000, got %', r.avg_monthly_income;
    END IF;
    IF ABS(r.savings_rate_pct - 73.13) > 0.5 THEN
        RAISE EXCEPTION '[savings_capacity] savings_rate_pct esperado ~73.13, got %', r.savings_rate_pct;
    END IF;
    IF r.months_to_goal IS NOT NULL THEN
        RAISE EXCEPTION '[savings_capacity] months_to_goal debería ser NULL, got %', r.months_to_goal;
    END IF;

    -- =============================================================
    -- 10. runway: con 2M de ahorro acumulado y gasto override de 500k → 4 meses
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'runway',
        2000000::NUMERIC,
        NULL, NULL,
        500000::NUMERIC,         -- expense override
        1, 0
    );
    IF ABS(r.runway_months - 4.0) > v_eps THEN
        RAISE EXCEPTION '[runway] runway_months esperado 4.0, got %', r.runway_months;
    END IF;

    -- =============================================================
    -- 11. runway sin gasto promedio (expense override = 0)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'runway',
        500000::NUMERIC,
        NULL, NULL,
        0::NUMERIC,
        1, 0
    );
    IF r.runway_months IS NOT NULL THEN
        RAISE EXCEPTION '[runway zero expense] runway_months debería ser NULL, got %', r.runway_months;
    END IF;

    -- =============================================================
    -- 12. forecast_month: tiene que devolver proyección > 0
    --     (depende del día del mes; valida que > 0 y >= total actual)
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'forecast_month',
        NULL, NULL, NULL, NULL, 1, 0
    );
    IF r.projected_month_total_expense IS NULL OR r.projected_month_total_expense <= 0 THEN
        RAISE EXCEPTION '[forecast] projected expense debería ser >0, got %', r.projected_month_total_expense;
    END IF;
    IF r.projected_month_total_income IS NULL OR r.projected_month_total_income <= 0 THEN
        RAISE EXCEPTION '[forecast] projected income debería ser >0, got %', r.projected_month_total_income;
    END IF;
    IF r.note NOT LIKE '%proyección%' THEN
        RAISE EXCEPTION '[forecast] note debería mencionar proyección, got "%"', r.note;
    END IF;

    -- =============================================================
    -- 13. extra_monthly_saving suma al saving
    -- =============================================================
    SELECT * INTO r FROM compute_financial_advice(
        v_uid, 'time_to_goal',
        1200000::NUMERIC,
        500000::NUMERIC,         -- saving base 500k
        NULL, NULL, 1,
        100000::NUMERIC          -- extra 100k → saving total 600k
    );
    IF ABS(r.monthly_saving - 600000) > v_eps THEN
        RAISE EXCEPTION '[extra saving] monthly_saving esperado 600000 (500k+100k), got %', r.monthly_saving;
    END IF;
    IF ABS(r.months_to_goal - 2.0) > v_eps THEN
        RAISE EXCEPTION '[extra saving] months_to_goal esperado 2.0, got %', r.months_to_goal;
    END IF;

    -- =============================================================
    -- 14. mode desconocido → RAISE EXCEPTION
    -- =============================================================
    BEGIN
        SELECT * INTO r FROM compute_financial_advice(
            v_uid, 'mode_que_no_existe',
            NULL, NULL, NULL, NULL, 1, 0
        );
        RAISE EXCEPTION '[unknown mode] debería haber tirado excepción';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT LIKE '%mode desconocido%' THEN
                RAISE EXCEPTION '[unknown mode] error inesperado: %', SQLERRM;
            END IF;
    END;

    -- =============================================================
    -- 15. mode vacío → RAISE EXCEPTION
    -- =============================================================
    BEGIN
        SELECT * INTO r FROM compute_financial_advice(
            v_uid, '',
            NULL, NULL, NULL, NULL, 1, 0
        );
        RAISE EXCEPTION '[empty mode] debería haber tirado excepción';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT LIKE '%mode requerido%' THEN
                RAISE EXCEPTION '[empty mode] error inesperado: %', SQLERRM;
            END IF;
    END;

    -- =============================================================
    -- 16. user isolation: otro usuario no debe afectar el cálculo
    -- =============================================================
    DECLARE
        v_other_uid UUID;
    BEGIN
        v_other_uid := bootstrap_user('__TEST_OTHER__9999', 'Otro');
        -- inserto un montón de plata para el otro user
        INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
        SELECT v_other_uid, 'income', 99999999, 'sueldo gigante',
               (SELECT id FROM categories WHERE user_id = v_other_uid AND normalized_name = 'otros' LIMIT 1),
               CURRENT_DATE - INTERVAL '20 days';

        SELECT * INTO r FROM compute_financial_advice(
            v_uid, 'savings_capacity',
            NULL, NULL, NULL, NULL, 1, 0
        );
        -- debería seguir viendo solo los 800k del user de test
        IF ABS(r.avg_monthly_income - 800000) > v_eps THEN
            RAISE EXCEPTION '[user isolation] el otro user contaminó el cálculo: avg_income=%', r.avg_monthly_income;
        END IF;

        DELETE FROM users WHERE id = v_other_uid;
    END;

    RAISE NOTICE 'PASS compute_financial_advice (16 escenarios)';
END $$;

ROLLBACK;
