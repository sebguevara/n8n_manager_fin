-- Test: create_tag + rename_tag + delete_tag + list_tags + tag/untag + suggest_tags
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_tag_id UUID;
    v_tx1 UUID; v_tx2 UUID; v_tx3 UUID;
    v_count INT;
    r RECORD;
BEGIN
    -- create_tag
    SELECT * INTO r FROM create_tag(v_uid, 'trabajo', '#FF6B6B');
    IF NOT r.was_created THEN RAISE EXCEPTION '[create_tag] expected was_created=true'; END IF;
    v_tag_id := r.tag_id;
    IF r.tag_name <> 'Trabajo' THEN RAISE EXCEPTION '[create_tag name] got %', r.tag_name; END IF;

    -- create_tag idempotente
    SELECT * INTO r FROM create_tag(v_uid, 'trabajo', NULL);
    IF r.was_created THEN RAISE EXCEPTION '[create_tag idempotent] should be false'; END IF;
    IF r.tag_id <> v_tag_id THEN RAISE EXCEPTION '[create_tag idempotent id] mismatch'; END IF;

    -- create_tag con nombre vacío → RAISE
    BEGIN
        PERFORM create_tag(v_uid, '', NULL);
        RAISE EXCEPTION '[create_tag empty] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%vacío%' THEN RAISE; END IF;
    END;

    -- Insertar tx para tagear (3 INSERTs separados; multi-row RETURNING INTO
    -- escalar levanta "more than one row" en PG ≥14 stricto)
    INSERT INTO transactions (user_id, type, amount, description, transaction_date)
    VALUES (v_uid, 'expense', 1500, 'almuerzo trabajo', CURRENT_DATE)
    RETURNING id INTO v_tx1;
    INSERT INTO transactions (user_id, type, amount, description, transaction_date)
    VALUES (v_uid, 'expense', 1700, 'almuerzo trabajo cliente', CURRENT_DATE)
    RETURNING id INTO v_tx2;
    INSERT INTO transactions (user_id, type, amount, description, transaction_date)
    VALUES (v_uid, 'expense', 800, 'café trabajo oficina', CURRENT_DATE)
    RETURNING id INTO v_tx3;

    -- tag_transactions: aplicar a 3
    SELECT * INTO r FROM tag_transactions(v_uid, 'trabajo',
        ARRAY[v_tx1, v_tx2, v_tx3], TRUE);
    IF r.tagged_count <> 3 THEN RAISE EXCEPTION '[tag_transactions] expected 3, got %', r.tagged_count; END IF;
    IF r.was_created THEN RAISE EXCEPTION '[tag_transactions] tag ya existía, was_created debe ser false'; END IF;

    -- Idempotente: re-aplicar mismo tag → 0 nuevas
    SELECT * INTO r FROM tag_transactions(v_uid, 'trabajo',
        ARRAY[v_tx1, v_tx2], TRUE);
    IF r.tagged_count <> 0 THEN RAISE EXCEPTION '[tag idempotent] expected 0, got %', r.tagged_count; END IF;

    -- tag_transactions con create_if_missing=true sobre tag nuevo
    SELECT * INTO r FROM tag_transactions(v_uid, 'cliente-x',
        ARRAY[v_tx2], TRUE);
    IF NOT r.was_created THEN RAISE EXCEPTION '[tag auto-create] expected was_created'; END IF;
    IF r.tagged_count <> 1 THEN RAISE EXCEPTION '[tag auto-create count] expected 1'; END IF;

    -- tag_transactions con create_if_missing=false sobre tag inexistente → RAISE
    BEGIN
        PERFORM tag_transactions(v_uid, 'no-existe-zzz', ARRAY[v_tx1], FALSE);
        RAISE EXCEPTION '[tag missing strict] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%No existe%' THEN RAISE; END IF;
    END;

    -- list_tags
    SELECT COUNT(*) INTO v_count FROM list_tags(v_uid) WHERE name ILIKE 'trabajo';
    IF v_count <> 1 THEN RAISE EXCEPTION '[list_tags] expected trabajo present'; END IF;
    SELECT tx_count, total_amount INTO r FROM list_tags(v_uid) WHERE name ILIKE 'trabajo';
    IF r.tx_count <> 3 THEN RAISE EXCEPTION '[list_tags count] expected 3, got %', r.tx_count; END IF;
    IF r.total_amount <> 4000 THEN RAISE EXCEPTION '[list_tags total] expected 4000, got %', r.total_amount; END IF;

    -- untag_transactions
    SELECT * INTO r FROM untag_transactions(v_uid, 'trabajo', ARRAY[v_tx3]);
    IF r.untagged_count <> 1 THEN RAISE EXCEPTION '[untag] expected 1, got %', r.untagged_count; END IF;
    SELECT tx_count INTO r FROM list_tags(v_uid) WHERE name ILIKE 'trabajo';
    IF r.tx_count <> 2 THEN RAISE EXCEPTION '[untag effect] expected 2, got %', r.tx_count; END IF;

    -- untag con tag inexistente → 0 (no error)
    SELECT * INTO r FROM untag_transactions(v_uid, '__no_zzz__', ARRAY[v_tx1]);
    IF r.untagged_count <> 0 THEN RAISE EXCEPTION '[untag bad tag] expected 0'; END IF;

    -- suggest_tags: descripción similar a las tageadas
    SELECT COUNT(*) INTO v_count FROM suggest_tags(v_uid, 'almuerzo trabajo nuevo cliente', NULL, 5);
    IF v_count < 1 THEN RAISE EXCEPTION '[suggest_tags] expected ≥1 sugerencia'; END IF;
    -- "trabajo" debería estar entre las sugeridas
    SELECT tag_name INTO r FROM suggest_tags(v_uid, 'almuerzo trabajo nuevo cliente', NULL, 5)
    WHERE tag_name ILIKE 'trabajo' LIMIT 1;
    IF r.tag_name IS NULL THEN RAISE EXCEPTION '[suggest_tags] trabajo missing'; END IF;

    -- suggest_tags con desc vacía → 0
    SELECT COUNT(*) INTO v_count FROM suggest_tags(v_uid, '', NULL, 5);
    IF v_count > 0 THEN RAISE EXCEPTION '[suggest empty desc] expected 0'; END IF;

    -- rename_tag
    SELECT * INTO r FROM rename_tag(v_uid, 'trabajo', 'laboral');
    IF NOT r.renamed THEN RAISE EXCEPTION '[rename_tag] failed'; END IF;
    IF r.new_name <> 'Laboral' THEN RAISE EXCEPTION '[rename_tag name] got %', r.new_name; END IF;

    -- rename a uno existente → RAISE
    BEGIN
        PERFORM rename_tag(v_uid, 'laboral', 'cliente-x');
        RAISE EXCEPTION '[rename conflict] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%Ya tenés%' THEN RAISE; END IF;
    END;

    -- delete_tag
    SELECT * INTO r FROM delete_tag(v_uid, 'laboral');
    IF NOT r.deleted THEN RAISE EXCEPTION '[delete_tag] failed'; END IF;
    IF r.untagged_transactions <> 2 THEN RAISE EXCEPTION '[delete_tag untagged] expected 2, got %', r.untagged_transactions; END IF;

    -- Verificar CASCADE: ya no hay transaction_tags asociados
    SELECT COUNT(*) INTO v_count FROM transaction_tags WHERE tag_id = v_tag_id;
    IF v_count <> 0 THEN RAISE EXCEPTION '[delete cascade] tt should be empty'; END IF;

    -- Aislamiento
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_tag', 'Other Tag') INTO v_other;
        SELECT * INTO r FROM tag_transactions(v_other, 'trabajo', ARRAY[v_tx1], TRUE);
        IF r.tagged_count > 0 THEN RAISE EXCEPTION '[isolation] otro user tageó tx ajena'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup
    DELETE FROM tags WHERE user_id = v_uid AND normalized_name IN ('cliente-x','trabajo','laboral');
    DELETE FROM transactions WHERE user_id = v_uid AND description LIKE '%trabajo%';

    RAISE NOTICE 'PASS tags CRUD + suggest';
END $$;
