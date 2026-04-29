-- Test: query_tx_dynamic
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    v_total BIGINT;
BEGIN
    -- this_month, default sort date_desc, returns 5 movs
    SELECT COUNT(*), MIN(total_count) INTO v_count, v_total
    FROM query_tx_dynamic(v_uid, '{"period":"this_month"}'::jsonb, 20, 0);
    IF v_count <> 5 THEN RAISE EXCEPTION '[query this_month] expected 5 returned, got %', v_count; END IF;
    IF v_total <> 5 THEN RAISE EXCEPTION '[query this_month] total_count expected 5, got %', v_total; END IF;

    -- limit 2
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"this_month"}'::jsonb, 2, 0);
    IF v_count <> 2 THEN RAISE EXCEPTION '[query limit 2] expected 2, got %', v_count; END IF;

    -- exact_amount=3300 → 3 transferencias
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"all","exact_amount":3300}'::jsonb, 20, 0);
    IF v_count <> 3 THEN RAISE EXCEPTION '[query exact 3300] expected 3, got %', v_count; END IF;

    -- description_contains 'maxi'
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"all","description_contains":"maxi"}'::jsonb, 20, 0);
    IF v_count <> 3 THEN RAISE EXCEPTION '[query desc maxi] expected 3, got %', v_count; END IF;

    -- min_amount 5000
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"all","min_amount":5000}'::jsonb, 20, 0);
    IF v_count <> 1 THEN RAISE EXCEPTION '[query min 5000] expected 1 (the supermercado), got %', v_count; END IF;

    -- pagination offset 3 → returns last 2
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"this_month"}'::jsonb, 20, 3);
    IF v_count <> 2 THEN RAISE EXCEPTION '[query offset 3] expected 2, got %', v_count; END IF;

    RAISE NOTICE 'PASS query_tx_dynamic';
END $$;
