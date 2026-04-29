-- Test: list_categories_with_counts + toggle_category_exclusion + rename_category + merge_categories
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_count INT;
    v_cat_id UUID;
    v_tx_count INT;
BEGIN
    -- list_categories: should include Comida with 2 txs
    SELECT * INTO r FROM list_categories_with_counts(v_uid, 'expense', false)
    WHERE name ILIKE 'comida';
    IF r.tx_count < 2 THEN RAISE EXCEPTION '[list_cats] Comida should have ≥2 txs, got %', r.tx_count; END IF;

    -- toggle_category_exclusion: exclude Comida
    SELECT id INTO v_cat_id FROM categories WHERE user_id = v_uid AND normalized_name = 'comida' LIMIT 1;
    SELECT * INTO r FROM toggle_category_exclusion(v_uid, 'comida');
    IF NOT r.excluded THEN RAISE EXCEPTION '[toggle excl] should be excluded after toggle'; END IF;

    -- After test 06 deleted 2 of 3 transferencias, only 1 remains (3300).
    -- After excluding Comida, only that 1 transferencia is visible.
    DECLARE v_total NUMERIC; v_before NUMERIC;
    BEGIN
        SELECT total INTO v_before FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense"}'::jsonb);
        -- v_before is the total this_month BEFORE we re-toggle: should already exclude comida = 3300
        SELECT total INTO v_total FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense"}'::jsonb);
        IF v_total >= v_before + 1 THEN
            RAISE EXCEPTION '[toggle excl effect] excluding comida did not lower total, got %', v_total;
        END IF;
        -- Total without comida = original - cafés (4000)
        IF v_total >= 4000 THEN
            RAISE EXCEPTION '[toggle excl effect] expected total < 4000 after excluding cafés, got %', v_total;
        END IF;
    END;

    -- Toggle again to include
    PERFORM toggle_category_exclusion(v_uid, 'comida');
    SELECT excluded_from_reports INTO r FROM categories WHERE id = v_cat_id;
    IF r.excluded_from_reports THEN RAISE EXCEPTION '[toggle excl back] should be NOT excluded'; END IF;

    -- rename_category: Comida → Alimentación
    SELECT * INTO r FROM rename_category(v_uid, 'comida', 'alimentación');
    IF NOT r.renamed THEN RAISE EXCEPTION '[rename] failed'; END IF;
    IF r.new_name NOT ILIKE 'alimentación' THEN RAISE EXCEPTION '[rename name] got %', r.new_name; END IF;

    -- Verify: txs still associated, find by new name works
    SELECT total INTO r FROM get_total_dynamic(v_uid, '{"period":"this_month","type":"expense","category":"alimentación"}'::jsonb);
    IF r.total <> 4000 THEN RAISE EXCEPTION '[rename effect] expected 4000 in alimentación, got %', r.total; END IF;

    -- Restore name
    PERFORM rename_category(v_uid, 'alimentación', 'comida');

    -- merge_categories: create a temp source "test_merge", insert tx, merge into Comida
    DECLARE v_src UUID; v_tgt UUID; v_tx_id UUID; v_merge RECORD;
    BEGIN
        -- Create temp category
        SELECT category_id INTO v_src FROM resolve_or_create_category(v_uid, 'test_merge_cat', 'expense');
        SELECT id INTO v_tgt FROM categories WHERE user_id = v_uid AND normalized_name = 'comida';

        -- Insert tx to source
        INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date)
        VALUES (v_uid, 'expense', 1234, 'merge test', v_src, CURRENT_DATE)
        RETURNING id INTO v_tx_id;

        -- Merge source → target
        SELECT * INTO v_merge FROM merge_categories(v_uid, 'test_merge_cat', 'comida');
        IF NOT v_merge.success THEN RAISE EXCEPTION '[merge] failed'; END IF;
        IF v_merge.moved_transactions <> 1 THEN RAISE EXCEPTION '[merge tx count] expected 1, got %', v_merge.moved_transactions; END IF;

        -- Verify the tx now belongs to comida
        SELECT category_id INTO v_cat_id FROM transactions WHERE id = v_tx_id;
        IF v_cat_id <> v_tgt THEN RAISE EXCEPTION '[merge effect] tx not moved to target'; END IF;

        -- Source is deactivated
        SELECT is_active INTO r FROM categories WHERE id = v_src;
        IF r.is_active THEN RAISE EXCEPTION '[merge source] should be deactivated'; END IF;

        -- Cleanup the merge tx
        DELETE FROM transactions WHERE id = v_tx_id;
        DELETE FROM categories WHERE id = v_src;
    END;

    -- merge_categories should fail merging onto self
    BEGIN
        PERFORM merge_categories(v_uid, 'comida', 'comida');
        RAISE EXCEPTION '[merge self] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%consigo misma%' THEN RAISE; END IF;
    END;

    -- rename to existing name should fail (conflict)
    BEGIN
        PERFORM rename_category(v_uid, 'comida', 'café');  -- both exist
        RAISE EXCEPTION '[rename conflict] should have raised';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%Ya existe%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'PASS list_categories + toggle + rename + merge';
END $$;
