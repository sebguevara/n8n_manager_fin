-- Test: compare_periods
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
BEGIN
    SELECT * INTO r FROM compare_periods(v_uid, 'this_month', 'last_month', 'expense');
    IF r.total_a <> 13900 THEN RAISE EXCEPTION '[compare a] expected 13900, got %', r.total_a; END IF;
    IF r.total_b <> 15000 THEN RAISE EXCEPTION '[compare b] expected 15000, got %', r.total_b; END IF;
    IF r.delta_abs <> -1100 THEN RAISE EXCEPTION '[compare delta_abs] expected -1100, got %', r.delta_abs; END IF;

    -- Empty period: today vs yesterday → both 0
    SELECT * INTO r FROM compare_periods(v_uid, 'today', 'yesterday', 'expense');
    IF r.total_a <> 0 OR r.total_b <> 0 THEN RAISE EXCEPTION '[compare empty] expected 0/0'; END IF;
    IF r.delta_pct IS NOT NULL THEN RAISE EXCEPTION '[compare empty] delta_pct should be NULL when b=0'; END IF;

    RAISE NOTICE 'PASS compare_periods';
END $$;
