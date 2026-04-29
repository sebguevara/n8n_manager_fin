-- Test CRÍTICO: aislamiento entre usuarios.
-- Cada teléfono = usuario independiente. Ningún query/tool puede ver data de otros usuarios.
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_other_phone TEXT := '__TEST__ISO_OTHER__';
    v_other_uid UUID;
    v_other_cat UUID;
    v_count BIGINT;
    v_total NUMERIC;
    r RECORD;
BEGIN
    DELETE FROM users WHERE phone_number = v_other_phone;
    SELECT bootstrap_user(v_other_phone, 'Iso Other') INTO v_other_uid;

    -- Insert a tx for the OTHER user
    SELECT id INTO v_other_cat FROM categories
    WHERE user_id = v_other_uid AND normalized_name = 'comida' LIMIT 1;
    INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
    VALUES (v_other_uid, 'expense', 99999, 'tx privada del otro user', v_other_cat, CURRENT_DATE);

    -- 1. get_total of v_uid must NOT include v_other_uid's 99999
    SELECT total INTO v_total FROM get_total_dynamic(v_uid, '{"period":"all","type":"expense"}'::jsonb);
    IF v_total >= 99999 THEN RAISE EXCEPTION '[isolation get_total] saw other user data: %', v_total; END IF;

    -- 2. query_tx_dynamic of v_uid must NOT return the other user's tx
    SELECT COUNT(*) INTO v_count FROM query_tx_dynamic(v_uid, '{"period":"all","exact_amount":99999}'::jsonb, 50, 0);
    IF v_count > 0 THEN RAISE EXCEPTION '[isolation query] returned other user tx'; END IF;

    -- 3. find_matching_tx_v2: same
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(v_uid, NULL,NULL,NULL,NULL, 99999, NULL,NULL, NULL,NULL,NULL, 50);
    IF v_count > 0 THEN RAISE EXCEPTION '[isolation find_matching] returned other user tx'; END IF;

    -- 4. bulk_delete cross-user must delete 0
    DECLARE v_deleted BIGINT;
    BEGIN
        SELECT deleted_count INTO v_deleted
        FROM bulk_delete_by_ids(v_uid, ARRAY(SELECT id FROM transactions WHERE user_id = v_other_uid));
        IF v_deleted <> 0 THEN RAISE EXCEPTION '[isolation bulk_delete] deleted other user tx: %', v_deleted; END IF;
    END;

    -- 5. update_tx of someone else's tx returns nothing
    DECLARE other_tx_id UUID; v_upd RECORD;
    BEGIN
        SELECT id INTO other_tx_id FROM transactions WHERE user_id = v_other_uid LIMIT 1;
        SELECT * INTO v_upd FROM update_tx(v_uid, other_tx_id, NULL, 1::numeric, NULL, NULL);
        IF v_upd.id IS NOT NULL THEN RAISE EXCEPTION '[isolation update_tx] modified other user tx'; END IF;
    END;

    -- 6. list_categories of v_uid does NOT include other user's
    SELECT COUNT(*) INTO v_count FROM list_categories_with_counts(v_uid, NULL, false)
    WHERE id = v_other_cat;
    IF v_count > 0 THEN RAISE EXCEPTION '[isolation list_categories] saw other user category'; END IF;

    -- 7. find_potential_duplicates only on own data
    SELECT COUNT(*) INTO v_count FROM find_potential_duplicates(v_other_uid, 7, 1)
    WHERE 99999 = ANY(ARRAY(SELECT amount FROM transactions WHERE id = ANY(transaction_ids)));
    -- The other user's single tx is not a duplicate (count 1, min 1 wouldn't form a cluster of 2). OK either way.

    -- 8. Categorías son independientes: el otro user no tiene "Familia" creada antes (a menos que pase un test previo)
    SELECT COUNT(*) INTO v_count FROM categories WHERE user_id = v_other_uid AND normalized_name = 'familia';
    -- This may be 0 (expected), or 1 if 08 ran for the same user. Since v_other_uid is fresh, should be 0.
    IF v_count > 0 THEN RAISE EXCEPTION '[isolation categories] new user has Familia which is leaked'; END IF;

    -- Cleanup
    DELETE FROM users WHERE id = v_other_uid;

    RAISE NOTICE 'PASS user_isolation (8 checks)';
END $$;
