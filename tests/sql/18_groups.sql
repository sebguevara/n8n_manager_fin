-- Test: upsert_group + list_groups
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_gid1 UUID; v_gid2 UUID;
    r RECORD;
    v_count INT;
BEGIN
    -- Create
    SELECT upsert_group(v_uid, 'Viaje a Bariloche', 'trip') INTO v_gid1;
    IF v_gid1 IS NULL THEN RAISE EXCEPTION '[upsert_group] returned null'; END IF;

    -- Idempotent: same name → same uuid
    SELECT upsert_group(v_uid, 'Viaje a Bariloche', 'trip') INTO v_gid2;
    IF v_gid1 <> v_gid2 THEN RAISE EXCEPTION '[upsert idempotent] got different uuids'; END IF;

    -- Different group
    DECLARE v_gid3 UUID;
    BEGIN
        SELECT upsert_group(v_uid, 'Cumpleaños Fer', 'event') INTO v_gid3;
        IF v_gid3 = v_gid1 THEN RAISE EXCEPTION '[upsert different] got same uuid'; END IF;
    END;

    -- list_groups: 2 groups
    SELECT COUNT(*) INTO v_count FROM list_groups(v_uid, TRUE);
    IF v_count <> 2 THEN RAISE EXCEPTION '[list_groups] expected 2, got %', v_count; END IF;

    -- Insert tx in a group, list_groups shows total
    INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date, group_id)
    SELECT v_uid, 'expense', 8000, 'pasaje', id, CURRENT_DATE, v_gid1
    FROM categories WHERE user_id = v_uid AND normalized_name = 'transporte' LIMIT 1;

    SELECT * INTO r FROM list_groups(v_uid, TRUE) WHERE id = v_gid1;
    IF r.total <> 8000 THEN RAISE EXCEPTION '[list_groups total] expected 8000, got %', r.total; END IF;
    IF r.n <> 1 THEN RAISE EXCEPTION '[list_groups n] expected 1, got %', r.n; END IF;

    -- Cleanup
    DELETE FROM transactions WHERE user_id = v_uid AND group_id = v_gid1;
    DELETE FROM expense_groups WHERE user_id = v_uid AND id IN (v_gid1, v_gid2);
    DELETE FROM expense_groups WHERE user_id = v_uid;

    RAISE NOTICE 'PASS upsert_group + list_groups';
END $$;
