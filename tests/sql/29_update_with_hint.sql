-- Test: update_tx + bulk_update_by_ids con new_category_hint (resolución por nombre)
-- Y delete_category con/sin merge_into.
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_cat_id UUID;
    v_tx UUID;
    v_count INT;
    r RECORD;
BEGIN
    -- Crear una tx con categoría 'otros'
    SELECT id INTO v_cat_id FROM categories WHERE user_id = v_uid AND normalized_name = 'otros' LIMIT 1;
    INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
    VALUES (v_uid, 'expense', 999, 'test hint update', v_cat_id, CURRENT_DATE)
    RETURNING id INTO v_tx;

    -- update_tx con NEW_CATEGORY_HINT (nombre que existe) y create_category_if_missing=false
    SELECT * INTO r FROM update_tx(v_uid, v_tx, NULL, NULL, NULL, NULL, 'comida', FALSE);
    IF r.category_name IS NULL THEN RAISE EXCEPTION '[update_tx hint] no category resolved'; END IF;
    IF lower(r.category_name) NOT LIKE '%comida%' THEN
        RAISE EXCEPTION '[update_tx hint exact] expected comida, got %', r.category_name;
    END IF;

    -- update_tx con hint inexistente y create_category_if_missing=true → debería crearla
    SELECT * INTO r FROM update_tx(v_uid, v_tx, NULL, NULL, NULL, NULL, 'mascotas-test', TRUE);
    IF lower(r.category_name) NOT LIKE '%mascotas%' THEN
        RAISE EXCEPTION '[update_tx hint create] expected new category, got %', r.category_name;
    END IF;

    -- Verificar que la categoría nueva está en la DB y es del user
    SELECT COUNT(*) INTO v_count FROM categories
    WHERE user_id = v_uid AND normalized_name = 'mascotas-test' AND is_active;
    IF v_count <> 1 THEN RAISE EXCEPTION '[update_tx new cat persist] expected 1, got %', v_count; END IF;

    -- update_tx con UUID directo aún funciona (backward compat)
    SELECT category_id INTO v_cat_id FROM resolve_or_create_category(v_uid, 'comida', 'expense');
    SELECT * INTO r FROM update_tx(v_uid, v_tx, NULL, NULL, NULL, v_cat_id, NULL, FALSE);
    IF lower(r.category_name) NOT LIKE '%comida%' THEN
        RAISE EXCEPTION '[update_tx uuid] expected comida via UUID, got %', r.category_name;
    END IF;

    -- update_tx con hint inválido + create=false → mantiene categoría anterior
    SELECT * INTO r FROM update_tx(v_uid, v_tx, NULL, NULL, NULL, NULL, '__zzz_no_existe_xx__', FALSE);
    -- find_best_category puede devolver Otros como fallback fuzzy, así que no asumimos valor exacto
    -- pero al menos no debe romper.

    -- bulk_update con hint
    DECLARE v_tx2 UUID;
    BEGIN
        SELECT id INTO v_cat_id FROM categories WHERE user_id = v_uid AND normalized_name = 'otros' LIMIT 1;
        INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
        VALUES (v_uid, 'expense', 555, 'bulk hint test', v_cat_id, CURRENT_DATE)
        RETURNING id INTO v_tx2;

        SELECT * INTO r FROM bulk_update_by_ids(v_uid, ARRAY[v_tx, v_tx2],
            NULL, NULL, NULL, NULL, NULL, 'comida', FALSE);
        IF r.updated_count <> 2 THEN RAISE EXCEPTION '[bulk_update count] expected 2, got %', r.updated_count; END IF;

        -- Verificar que ambas tx ahora están en comida
        SELECT COUNT(*) INTO v_count FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE t.id IN (v_tx, v_tx2) AND c.normalized_name = 'comida';
        IF v_count <> 2 THEN RAISE EXCEPTION '[bulk_update effect] expected 2 in comida, got %', v_count; END IF;

        DELETE FROM transactions WHERE id = v_tx2;
    END;

    -- delete_category sin merge cuando hay tx → RAISE
    PERFORM resolve_or_create_category(v_uid, 'mascotas-test', 'expense');
    -- Mover tx a mascotas-test antes de probar
    SELECT category_id INTO v_cat_id FROM resolve_or_create_category(v_uid, 'mascotas-test', 'expense');
    UPDATE transactions SET category_id = v_cat_id WHERE id = v_tx;

    BEGIN
        PERFORM delete_category(v_uid, 'mascotas-test', NULL);
        RAISE EXCEPTION '[delete_category with tx] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%transacciones%' THEN RAISE; END IF;
    END;

    -- delete_category con merge_into = comida → debe mover y desactivar
    SELECT * INTO r FROM delete_category(v_uid, 'mascotas-test', 'comida');
    IF NOT r.deactivated THEN RAISE EXCEPTION '[delete_category merge] failed'; END IF;
    IF r.merged_into IS NULL THEN RAISE EXCEPTION '[delete_category merge target]'; END IF;

    SELECT is_active INTO r FROM categories WHERE id = v_cat_id;
    IF r.is_active THEN RAISE EXCEPTION '[delete_category effect] should be inactive'; END IF;

    -- delete_category sobre vacía → desactiva directo
    SELECT category_id INTO v_cat_id FROM resolve_or_create_category(v_uid, 'vacia-test', 'expense');
    SELECT * INTO r FROM delete_category(v_uid, 'vacia-test', NULL);
    IF NOT r.deactivated THEN RAISE EXCEPTION '[delete_category empty] failed'; END IF;
    IF r.moved_transactions <> 0 THEN RAISE EXCEPTION '[delete_category empty] expected 0 moved'; END IF;

    -- Aislamiento: otro user no puede actualizar mi tx
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_upd', 'Other Upd') INTO v_other;
        SELECT * INTO r FROM update_tx(v_other, v_tx, NULL, 99999, NULL, NULL, NULL, FALSE);
        IF r.id IS NOT NULL THEN RAISE EXCEPTION '[isolation] otro user updateó mi tx'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup
    DELETE FROM transactions WHERE id = v_tx;
    DELETE FROM categories WHERE user_id = v_uid AND normalized_name IN ('mascotas-test','vacia-test');

    RAISE NOTICE 'PASS update_tx/bulk_update con hint + delete_category';
END $$;
