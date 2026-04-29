-- Test: get_breakdown_dynamic — catches the "[null]" chart bug
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    r RECORD;
BEGIN
    -- by category, this_month: 2 categories (Comida 4000, Otros 9900)
    SELECT COUNT(*) INTO v_count FROM get_breakdown_dynamic(v_uid, 'category', '{"period":"this_month","type":"expense"}'::jsonb, 10);
    IF v_count <> 2 THEN RAISE EXCEPTION '[breakdown category] expected 2 rows, got %', v_count; END IF;

    -- No null labels — bug we hit on prod
    FOR r IN SELECT * FROM get_breakdown_dynamic(v_uid, 'category', '{"period":"this_month","type":"expense"}'::jsonb, 10) LOOP
        IF r.label IS NULL THEN RAISE EXCEPTION '[breakdown] label IS NULL — should never happen'; END IF;
        IF r.total IS NULL OR r.total <= 0 THEN RAISE EXCEPTION '[breakdown] total invalid: %', r.total; END IF;
    END LOOP;

    -- Top category by total = Otros (9900)
    SELECT label INTO r FROM get_breakdown_dynamic(v_uid, 'category', '{"period":"this_month","type":"expense"}'::jsonb, 1);
    IF r.label NOT ILIKE 'otros' THEN RAISE EXCEPTION '[breakdown top] expected Otros, got %', r.label; END IF;

    -- by day, this_month: should have 3 distinct days
    SELECT COUNT(*) INTO v_count FROM get_breakdown_dynamic(v_uid, 'day', '{"period":"this_month","type":"expense"}'::jsonb, 30);
    IF v_count <> 3 THEN RAISE EXCEPTION '[breakdown day] expected 3 days, got %', v_count; END IF;

    -- Empty period (yesterday — no data) returns 0 rows, NOT a row with NULLs
    SELECT COUNT(*) INTO v_count FROM get_breakdown_dynamic(v_uid, 'category', '{"period":"yesterday","type":"expense"}'::jsonb, 10);
    IF v_count <> 0 THEN RAISE EXCEPTION '[breakdown empty] expected 0 rows for yesterday, got %', v_count; END IF;

    RAISE NOTICE 'PASS get_breakdown_dynamic';
END $$;
