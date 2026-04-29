-- Test: remember_last_list / get_last_list — for deictic references
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_items JSONB;
BEGIN
    v_items := '[{"position":1,"id":"aaa","amount":2000,"description":"café"},{"position":2,"id":"bbb","amount":3300,"description":"transferencia"}]'::jsonb;

    PERFORM remember_last_list(v_uid, 'transactions', v_items, '{"period":"this_month"}'::jsonb, 600);

    SELECT * INTO r FROM get_last_list(v_uid);
    IF r.kind <> 'transactions' THEN RAISE EXCEPTION '[remember_last] kind=%', r.kind; END IF;
    IF jsonb_array_length(r.items) <> 2 THEN RAISE EXCEPTION '[remember_last] items length=%', jsonb_array_length(r.items); END IF;
    IF NOT r.is_fresh THEN RAISE EXCEPTION '[remember_last] should be fresh'; END IF;

    -- Verify item shape preserved
    IF r.items->0->>'id' <> 'aaa' THEN RAISE EXCEPTION '[remember_last] item[0].id wrong'; END IF;

    RAISE NOTICE 'PASS remember_last_list';
END $$;
