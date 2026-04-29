-- Test: update_tx + bulk_update_by_ids
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_tx UUID;
    v_cat UUID;
    r RECORD;
    v_count BIGINT;
BEGIN
    SELECT id INTO v_tx FROM transactions WHERE user_id = v_uid AND amount = 2000 LIMIT 1;

    -- Single update: change amount + description
    SELECT * INTO r FROM update_tx(v_uid, v_tx, NULL, 5555::numeric, 'café actualizado', NULL);
    IF r.amount <> 5555 THEN RAISE EXCEPTION '[update_tx amount] expected 5555, got %', r.amount; END IF;
    IF r.description <> 'café actualizado' THEN RAISE EXCEPTION '[update_tx desc] got %', r.description; END IF;

    -- Restore for clean state
    PERFORM update_tx(v_uid, v_tx, NULL, 2000::numeric, 'café del día 1', NULL);

    -- Bulk update: change date for both cafés
    SELECT category_id INTO v_cat FROM transactions WHERE id = v_tx;
    SELECT updated_count INTO v_count
    FROM bulk_update_by_ids(
        v_uid,
        ARRAY(SELECT id FROM transactions WHERE user_id = v_uid AND amount = 2000),
        NULL, CURRENT_DATE - 5, NULL, NULL, NULL
    );
    IF v_count <> 2 THEN RAISE EXCEPTION '[bulk_update] expected 2, got %', v_count; END IF;

    -- Verify date changed
    SELECT COUNT(*) INTO v_count FROM transactions
    WHERE user_id = v_uid AND amount = 2000 AND transaction_date = CURRENT_DATE - 5;
    IF v_count <> 2 THEN RAISE EXCEPTION '[bulk_update verify] expected 2 with new date, got %', v_count; END IF;

    -- Bulk update with amount_delta: +500 to both
    SELECT updated_count INTO v_count
    FROM bulk_update_by_ids(
        v_uid,
        ARRAY(SELECT id FROM transactions WHERE user_id = v_uid AND amount = 2000),
        NULL, NULL, NULL, 500::numeric, NULL
    );
    IF v_count <> 2 THEN RAISE EXCEPTION '[bulk_update delta] expected 2 updates'; END IF;
    SELECT COUNT(*) INTO v_count FROM transactions WHERE user_id = v_uid AND amount = 2500;
    IF v_count <> 2 THEN RAISE EXCEPTION '[bulk_update delta verify] expected 2 with amount 2500, got %', v_count; END IF;

    -- Restore amounts
    PERFORM bulk_update_by_ids(
        v_uid,
        ARRAY(SELECT id FROM transactions WHERE user_id = v_uid AND amount = 2500),
        NULL, NULL, NULL, -500::numeric, NULL
    );
    -- Restore date to original
    PERFORM bulk_update_by_ids(
        v_uid,
        ARRAY(SELECT id FROM transactions WHERE user_id = v_uid AND amount = 2000),
        NULL, DATE_TRUNC('month', CURRENT_DATE)::DATE, NULL, NULL, NULL
    );

    RAISE NOTICE 'PASS update_tx + bulk_update_by_ids';
END $$;
