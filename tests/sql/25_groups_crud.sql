-- Test: update_group + rename_group + close_group + delete_group
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_grp_a UUID;
    v_grp_b UUID;
    v_tx_id UUID;
    v_count INT;
    r RECORD;
BEGIN
    -- Setup: dos grupos
    SELECT upsert_group(v_uid, 'Viaje Brasil', 'trip') INTO v_grp_a;
    SELECT upsert_group(v_uid, 'Cumple Mama', 'event') INTO v_grp_b;

    -- update_group: cambiar emoji + fechas
    SELECT * INTO r FROM update_group(v_uid, 'Viaje Brasil', NULL, NULL, '✈️',
        CURRENT_DATE, CURRENT_DATE + 10);
    IF r.emoji <> '✈️' THEN RAISE EXCEPTION '[update_group emoji] got %', r.emoji; END IF;
    IF r.starts_at IS NULL OR r.ends_at IS NULL THEN
        RAISE EXCEPTION '[update_group dates] not set';
    END IF;

    -- update_group con kind inválido → RAISE
    BEGIN
        PERFORM update_group(v_uid, 'Viaje Brasil', NULL, 'invalid_kind', NULL, NULL, NULL);
        RAISE EXCEPTION '[update_group bad kind] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%kind inválido%' THEN RAISE; END IF;
    END;

    -- rename_group: renombrar
    SELECT * INTO r FROM rename_group(v_uid, 'Viaje Brasil', 'Vacaciones Playa');
    IF NOT r.renamed THEN RAISE EXCEPTION '[rename_group] failed'; END IF;
    IF r.new_name <> 'Vacaciones Playa' THEN RAISE EXCEPTION '[rename_group name] got %', r.new_name; END IF;

    -- rename a uno que no existe → renamed=false
    SELECT * INTO r FROM rename_group(v_uid, 'no_existe_zzz', 'cualquier');
    IF r.renamed THEN RAISE EXCEPTION '[rename_group nonexistent] should fail'; END IF;

    -- update_group con conflicto de nombre → RAISE
    BEGIN
        PERFORM update_group(v_uid, 'Vacaciones Playa', 'Cumple Mama', NULL, NULL, NULL, NULL);
        RAISE EXCEPTION '[update_group name conflict] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%Ya tenés un grupo%' THEN RAISE; END IF;
    END;

    -- Asociar tx al grupo A para probar delete con tx
    INSERT INTO transactions (user_id, type, amount, description, group_id, transaction_date)
    VALUES (v_uid, 'expense', 100, 'gasto en grupo', v_grp_a, CURRENT_DATE)
    RETURNING id INTO v_tx_id;

    -- delete_group con tx y sin reassign/unassign → RAISE
    BEGIN
        PERFORM delete_group(v_uid, 'Vacaciones Playa', NULL, FALSE);
        RAISE EXCEPTION '[delete_group with tx] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%transacciones%' THEN RAISE; END IF;
    END;

    -- delete_group con reassign → mueve la tx
    SELECT * INTO r FROM delete_group(v_uid, 'Vacaciones Playa', 'Cumple Mama', FALSE);
    IF NOT r.deleted THEN RAISE EXCEPTION '[delete_group reassign] failed'; END IF;
    IF r.moved_transactions <> 1 THEN RAISE EXCEPTION '[delete_group moved] expected 1, got %', r.moved_transactions; END IF;

    SELECT group_id INTO r FROM transactions WHERE id = v_tx_id;
    IF r.group_id <> v_grp_b THEN RAISE EXCEPTION '[delete_group reassigned tx] not moved'; END IF;

    -- close_group: cerrar el restante
    SELECT * INTO r FROM close_group(v_uid, 'Cumple Mama');
    IF NOT r.closed THEN RAISE EXCEPTION '[close_group] failed'; END IF;
    IF r.ends_at IS NULL THEN RAISE EXCEPTION '[close_group ends_at] should be set'; END IF;

    SELECT is_active INTO r FROM expense_groups WHERE id = v_grp_b;
    IF r.is_active THEN RAISE EXCEPTION '[close_group effect] should be inactive'; END IF;

    -- delete_group con unassign=true
    SELECT upsert_group(v_uid, 'Trip Test 3', 'trip') INTO v_grp_a;
    INSERT INTO transactions (user_id, type, amount, description, group_id, transaction_date)
    VALUES (v_uid, 'expense', 200, 'otro gasto', v_grp_a, CURRENT_DATE);

    SELECT * INTO r FROM delete_group(v_uid, 'Trip Test 3', NULL, TRUE);
    IF NOT r.deleted THEN RAISE EXCEPTION '[delete_group unassign] failed'; END IF;
    SELECT COUNT(*) INTO v_count FROM transactions
        WHERE user_id = v_uid AND group_id IS NULL AND description = 'otro gasto';
    IF v_count <> 1 THEN RAISE EXCEPTION '[delete_group unassign tx] expected 1 NULL group_id'; END IF;

    -- Aislamiento: otro user no puede tocar mis grupos
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_grp', 'Other Grp') INTO v_other;
        SELECT * INTO r FROM rename_group(v_other, 'Cumple Mama', 'Robado');
        IF r.renamed THEN RAISE EXCEPTION '[isolation] otro user renombró mi grupo'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup
    DELETE FROM transactions WHERE user_id = v_uid AND description IN ('gasto en grupo','otro gasto');
    DELETE FROM expense_groups WHERE user_id = v_uid AND name IN ('Cumple Mama');

    RAISE NOTICE 'PASS groups CRUD';
END $$;
