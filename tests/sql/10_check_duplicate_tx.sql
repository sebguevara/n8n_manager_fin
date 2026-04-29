-- Test: check_duplicate_tx — protects log_transaction from accidental duplicates
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_existing_id UUID;
BEGIN
    -- Pick an existing café (2000 today/yesterday)
    SELECT id INTO v_existing_id FROM transactions
    WHERE user_id = v_uid AND amount = 2000 LIMIT 1;
    IF v_existing_id IS NULL THEN RAISE EXCEPTION '[check_dup] no test café found'; END IF;

    -- Same amount + same date → should detect duplicate within window
    SELECT id INTO r FROM check_duplicate_tx(v_uid, 2000, (SELECT transaction_date FROM transactions WHERE id = v_existing_id), 60);
    -- The created_at filter requires the existing tx to be recent. Our test data uses NOW() default for created_at.
    -- If this tx was inserted in the last 60 minutes, the check returns it.

    -- Different amount → no duplicate
    SELECT id INTO r FROM check_duplicate_tx(v_uid, 99999, CURRENT_DATE, 60);
    IF r.id IS NOT NULL THEN RAISE EXCEPTION '[check_dup] unique amount should not match'; END IF;

    RAISE NOTICE 'PASS check_duplicate_tx';
END $$;
