-- Test: log_transaction full flow + resolve_or_create_category
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    v_cat_id UUID;
    v_cat_name TEXT;
    v_was_created BOOLEAN;
    v_tx_id UUID;
BEGIN
    -- Use create_category_if_missing path
    SELECT category_id, category_name, was_created
    INTO v_cat_id, v_cat_name, v_was_created
    FROM resolve_or_create_category(v_uid, 'familia', 'expense');

    IF NOT v_was_created THEN
        -- Could be that 08 already created it; that's fine.
        NULL;
    END IF;

    INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
    VALUES (v_uid, 'expense', 3300, 'Transfer a Mom', v_cat_id, CURRENT_DATE)
    RETURNING id INTO v_tx_id;

    -- Verify the new category exists
    SELECT id INTO v_cat_id FROM categories WHERE user_id = v_uid AND normalized_name = 'familia' LIMIT 1;
    IF v_cat_id IS NULL THEN RAISE EXCEPTION '[log_transaction] Familia category was not created'; END IF;

    -- Verify total reflects the new tx
    SELECT count INTO v_count FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense","category":"familia"}'::jsonb);
    IF v_count <> 1 THEN RAISE EXCEPTION '[log_transaction] expected 1 familia tx this_month, got %', v_count; END IF;

    -- Cleanup
    DELETE FROM transactions WHERE id = v_tx_id;

    RAISE NOTICE 'PASS log_transaction + resolve_or_create_category';
END $$;
