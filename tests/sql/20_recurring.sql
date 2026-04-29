-- Test: recurring_transactions + process_due_recurring
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
    SELECT id INTO v_cat FROM categories WHERE user_id = v_uid AND normalized_name = 'suscripciones' LIMIT 1;
    IF v_cat IS NULL THEN
        SELECT id INTO v_cat FROM categories WHERE user_id = v_uid AND normalized_name = 'otros' LIMIT 1;
    END IF;

    -- Insert a recurring tx that's already due (next_occurrence = today)
    INSERT INTO recurring_transactions (
        user_id, type, amount, description, category_id, frequency, next_occurrence, is_active
    ) VALUES (
        v_uid, 'expense', 5500, 'Netflix', v_cat, 'monthly', CURRENT_DATE, TRUE
    ) RETURNING id INTO v_rec_id;

    -- Run the processor (function returns out_user_id, etc.)
    SELECT COUNT(*) INTO v_count FROM process_due_recurring() WHERE out_user_id = v_uid;
    IF v_count < 1 THEN RAISE EXCEPTION '[process_due] expected ≥1 processed, got %', v_count; END IF;

    -- Verify a new tx was created
    SELECT COUNT(*) INTO v_count FROM transactions
    WHERE user_id = v_uid AND amount = 5500 AND description = 'Netflix' AND transaction_date = CURRENT_DATE;
    IF v_count <> 1 THEN RAISE EXCEPTION '[process_due tx] expected 1 Netflix tx, got %', v_count; END IF;

    -- Verify next_occurrence advanced
    SELECT next_occurrence INTO r FROM recurring_transactions WHERE id = v_rec_id;
    IF r.next_occurrence <= CURRENT_DATE THEN RAISE EXCEPTION '[process_due next_occurrence] should advance: %', r.next_occurrence; END IF;

    -- Running again same day should not duplicate
    SELECT COUNT(*) INTO v_count FROM process_due_recurring() WHERE out_user_id = v_uid;
    IF v_count > 0 THEN RAISE EXCEPTION '[process_due idempotent] processed twice in same day'; END IF;

    -- Cleanup
    DELETE FROM transactions WHERE user_id = v_uid AND description = 'Netflix';
    DELETE FROM recurring_transactions WHERE id = v_rec_id;

    RAISE NOTICE 'PASS recurring_transactions';
END $$;
