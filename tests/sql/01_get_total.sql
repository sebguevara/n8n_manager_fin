-- Test: get_total_dynamic
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_total NUMERIC; v_count BIGINT;
BEGIN
    -- this_month: 2 cafés (2000+2000) + 3 transferencias (3300x3) = 13900, 5 movs
    SELECT total, count INTO v_total, v_count
    FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense"}'::jsonb);
    IF v_total <> 13900 THEN RAISE EXCEPTION '[get_total this_month] expected 13900, got %', v_total; END IF;
    IF v_count <> 5 THEN RAISE EXCEPTION '[get_total this_month] expected 5 movs, got %', v_count; END IF;

    -- last_month: 1 super 15000
    SELECT total, count INTO v_total, v_count
    FROM get_total_dynamic(v_uid, '{"period":"last_month","type":"expense"}'::jsonb);
    IF v_total <> 15000 THEN RAISE EXCEPTION '[get_total last_month] expected 15000, got %', v_total; END IF;
    IF v_count <> 1 THEN RAISE EXCEPTION '[get_total last_month] expected 1 mov, got %', v_count; END IF;

    -- all
    SELECT total, count INTO v_total, v_count
    FROM get_total_dynamic(v_uid, '{"period":"all","type":"expense"}'::jsonb);
    IF v_total <> 28900 THEN RAISE EXCEPTION '[get_total all] expected 28900, got %', v_total; END IF;
    IF v_count <> 6 THEN RAISE EXCEPTION '[get_total all] expected 6 movs, got %', v_count; END IF;

    -- filter by category=comida
    SELECT total, count INTO v_total, v_count
    FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense","category":"comida"}'::jsonb);
    IF v_total <> 4000 THEN RAISE EXCEPTION '[get_total comida] expected 4000, got %', v_total; END IF;

    RAISE NOTICE 'PASS get_total_dynamic';
END $$;
