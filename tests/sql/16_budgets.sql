-- Test: set_budget + check_budget_status + pending_budget_alerts + mark_budget_alert_sent
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_cat_id UUID;
    r RECORD;
    v_count BIGINT;
BEGIN
    -- Set budget on Comida (we have $4000 in cafés this month with the original data)
    SELECT * INTO r FROM set_budget(v_uid, 'comida', 5000::numeric, 'monthly');
    IF r.category_name NOT ILIKE 'comida' THEN RAISE EXCEPTION '[set_budget] got %', r.category_name; END IF;
    IF r.amount <> 5000 THEN RAISE EXCEPTION '[set_budget amount] got %', r.amount; END IF;

    -- check_budget_status: 4000 / 5000 = 80% → near_budget alert
    SELECT id INTO v_cat_id FROM categories WHERE user_id = v_uid AND normalized_name = 'comida' LIMIT 1;
    SELECT * INTO r FROM check_budget_status(v_uid, v_cat_id);
    IF NOT r.should_alert THEN RAISE EXCEPTION '[check_budget] should alert at 80%%'; END IF;
    IF r.level <> 'near_budget' THEN RAISE EXCEPTION '[check_budget level] expected near_budget, got %', r.level; END IF;

    -- pending_budget_alerts: should include this one
    SELECT COUNT(*) INTO v_count FROM pending_budget_alerts() WHERE user_id = v_uid;
    IF v_count < 1 THEN RAISE EXCEPTION '[pending_alerts] expected ≥1, got %', v_count; END IF;

    -- Mark sent → should be removed from pending for 18h
    DECLARE v_budget_id UUID;
    BEGIN
        SELECT budget_id INTO v_budget_id FROM pending_budget_alerts() WHERE user_id = v_uid LIMIT 1;
        PERFORM mark_budget_alert_sent(v_uid, v_budget_id, 'near_budget');

        SELECT COUNT(*) INTO v_count FROM pending_budget_alerts() WHERE user_id = v_uid AND budget_id = v_budget_id AND level = 'near_budget';
        IF v_count > 0 THEN RAISE EXCEPTION '[mark_sent] alert still pending after marking'; END IF;
    END;

    -- Update budget: set to 3000 → now over_budget (4000 > 3000)
    PERFORM set_budget(v_uid, 'comida', 3000::numeric, 'monthly');
    SELECT * INTO r FROM check_budget_status(v_uid, v_cat_id);
    IF r.level <> 'over_budget' THEN RAISE EXCEPTION '[over_budget] expected over, got %', r.level; END IF;

    -- Cleanup
    DELETE FROM budgets WHERE user_id = v_uid AND category_id = v_cat_id;
    DELETE FROM budget_alert_log WHERE user_id = v_uid;

    RAISE NOTICE 'PASS budgets';
END $$;
