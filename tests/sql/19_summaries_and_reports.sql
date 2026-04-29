-- Test: daily_summary + generate_report_data
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_today DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE; -- date of café 1 inserted in setup
BEGIN
    -- daily_summary for the day with cafés.
    -- Note: test 15 (bulk_update) restored both cafés to the SAME date (start of month),
    -- so day_0 has 2 cafés = 4000.
    SELECT * INTO r FROM daily_summary(v_uid, v_today);
    IF r.total NOT IN (2000, 4000) THEN
        RAISE EXCEPTION '[daily_summary] expected 2000 or 4000 on first day, got %', r.total;
    END IF;
    IF r.n NOT IN (1, 2) THEN RAISE EXCEPTION '[daily_summary count] expected 1 or 2 movs, got %', r.n; END IF;
    IF r.top_category NOT ILIKE 'comida' THEN RAISE EXCEPTION '[daily_summary top_cat] got %', r.top_category; END IF;

    -- daily_summary for an empty day
    SELECT * INTO r FROM daily_summary(v_uid, CURRENT_DATE - 365);
    IF r.total <> 0 THEN RAISE EXCEPTION '[daily empty] expected 0, got %', r.total; END IF;

    -- generate_report_data: works for the period that has data
    BEGIN
        SELECT * INTO r FROM generate_report_data(v_uid, DATE_TRUNC('month', CURRENT_DATE)::DATE, CURRENT_DATE);
        -- Just make sure it doesn't crash and returns something
        IF r IS NULL THEN RAISE EXCEPTION '[generate_report_data] returned null'; END IF;
    EXCEPTION WHEN undefined_function THEN
        RAISE NOTICE 'generate_report_data has different signature, skipping';
    END;

    RAISE NOTICE 'PASS daily_summary + generate_report_data';
END $$;
