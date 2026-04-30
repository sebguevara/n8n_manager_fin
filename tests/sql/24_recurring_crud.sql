-- Test: list_recurring + update_recurring + pause/resume/cancel_recurring
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_cat UUID;
    v_rec_id UUID;
    v_count INT;
    r RECORD;
BEGIN
    -- Pick or create a category
    SELECT id INTO v_cat FROM categories WHERE user_id = v_uid AND normalized_name = 'suscripciones' LIMIT 1;
    IF v_cat IS NULL THEN
        SELECT category_id INTO v_cat FROM resolve_or_create_category(v_uid, 'suscripciones', 'expense');
    END IF;

    -- Crear recurrente para test
    INSERT INTO recurring_transactions (user_id, type, amount, description, category_id, frequency, next_occurrence, is_active)
    VALUES (v_uid, 'expense', 5500, 'Netflix CRUD', v_cat, 'monthly', CURRENT_DATE + 30, TRUE)
    RETURNING id INTO v_rec_id;

    -- list_recurring active_only=true → debería incluirla
    SELECT COUNT(*) INTO v_count FROM list_recurring(v_uid, TRUE) WHERE id = v_rec_id;
    IF v_count <> 1 THEN RAISE EXCEPTION '[list_recurring active] expected 1, got %', v_count; END IF;

    -- update_recurring: cambiar monto y descripción
    SELECT * INTO r FROM update_recurring(v_uid, v_rec_id,
        7000, 'Netflix Premium', NULL, NULL, NULL, NULL, FALSE);
    IF r.amount <> 7000 THEN RAISE EXCEPTION '[update_recurring amount] got %', r.amount; END IF;
    IF r.description <> 'Netflix Premium' THEN RAISE EXCEPTION '[update_recurring desc] got %', r.description; END IF;

    -- update con category_hint inválido (no existe + no crear)
    SELECT * INTO r FROM update_recurring(v_uid, v_rec_id,
        NULL, NULL, NULL, '__categoria_no_existe_xyz__', NULL, NULL, FALSE);
    IF r.id IS NULL THEN RAISE EXCEPTION '[update_recurring nohint] should still update other fields'; END IF;

    -- update con category_hint + create_if_missing
    SELECT * INTO r FROM update_recurring(v_uid, v_rec_id,
        NULL, NULL, NULL, 'streaming-test', NULL, NULL, TRUE);
    IF r.category_name IS NULL THEN RAISE EXCEPTION '[update_recurring create_cat] expected category set'; END IF;

    -- update con frequency inválida → debe RAISE
    BEGIN
        PERFORM update_recurring(v_uid, v_rec_id, NULL, NULL, 'invalid_freq', NULL, NULL, NULL, FALSE);
        RAISE EXCEPTION '[update_recurring bad_freq] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%frecuencia inválida%' THEN RAISE; END IF;
    END;

    -- pause_recurring
    SELECT * INTO r FROM pause_recurring(v_uid, v_rec_id);
    IF NOT r.paused THEN RAISE EXCEPTION '[pause] failed'; END IF;
    IF NOT r.was_active THEN RAISE EXCEPTION '[pause] expected was_active=true (estaba activa)'; END IF;
    SELECT is_active INTO r FROM recurring_transactions WHERE id = v_rec_id;
    IF r.is_active THEN RAISE EXCEPTION '[pause effect] should be inactive'; END IF;

    -- list_recurring active_only=true → ya NO debe estar
    SELECT COUNT(*) INTO v_count FROM list_recurring(v_uid, TRUE) WHERE id = v_rec_id;
    IF v_count <> 0 THEN RAISE EXCEPTION '[list active after pause] expected 0, got %', v_count; END IF;
    -- pero active_only=false sí debe estar
    SELECT COUNT(*) INTO v_count FROM list_recurring(v_uid, FALSE) WHERE id = v_rec_id;
    IF v_count <> 1 THEN RAISE EXCEPTION '[list all after pause] expected 1, got %', v_count; END IF;

    -- resume_recurring
    SELECT * INTO r FROM resume_recurring(v_uid, v_rec_id);
    IF NOT r.resumed THEN RAISE EXCEPTION '[resume] failed'; END IF;
    SELECT is_active INTO r FROM recurring_transactions WHERE id = v_rec_id;
    IF NOT r.is_active THEN RAISE EXCEPTION '[resume effect] should be active'; END IF;

    -- cancel_recurring (definitivo)
    SELECT * INTO r FROM cancel_recurring(v_uid, v_rec_id);
    IF NOT r.cancelled THEN RAISE EXCEPTION '[cancel] failed'; END IF;
    SELECT is_active, end_date INTO r FROM recurring_transactions WHERE id = v_rec_id;
    IF r.is_active THEN RAISE EXCEPTION '[cancel] should be inactive'; END IF;
    IF r.end_date IS NULL THEN RAISE EXCEPTION '[cancel] end_date should be set'; END IF;

    -- pause/resume/cancel sobre id inexistente
    SELECT * INTO r FROM pause_recurring(v_uid, gen_random_uuid());
    IF r.paused THEN RAISE EXCEPTION '[pause nonexistent] should fail'; END IF;
    SELECT * INTO r FROM cancel_recurring(v_uid, gen_random_uuid());
    IF r.cancelled THEN RAISE EXCEPTION '[cancel nonexistent] should fail'; END IF;

    -- Aislamiento: otro usuario no puede pausar la mía
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_rec', 'Other Rec') INTO v_other;
        SELECT * INTO r FROM pause_recurring(v_other, v_rec_id);
        IF r.paused THEN RAISE EXCEPTION '[isolation] otro user pudo pausar la mía'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup
    DELETE FROM recurring_transactions WHERE id = v_rec_id;
    DELETE FROM categories WHERE user_id = v_uid AND normalized_name = 'streaming-test';

    RAISE NOTICE 'PASS recurring CRUD';
END $$;
