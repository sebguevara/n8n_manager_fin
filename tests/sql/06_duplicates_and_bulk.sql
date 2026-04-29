-- Test: find_potential_duplicates + bulk_delete_by_ids
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_ids UUID[];
    v_deleted BIGINT;
BEGIN
    -- 3 transferencias of 3300 same day = 1 cluster of 3
    SELECT * INTO r FROM find_potential_duplicates(v_uid, 7, 2);
    IF r.tx_count <> 3 THEN RAISE EXCEPTION '[duplicates] expected cluster of 3, got %', r.tx_count; END IF;
    IF r.total_amount <> 9900 THEN RAISE EXCEPTION '[duplicates total] expected 9900, got %', r.total_amount; END IF;

    -- Save 2 of those ids for bulk delete
    v_ids := r.transaction_ids[1:2];
    SELECT deleted_count INTO v_deleted FROM bulk_delete_by_ids(v_uid, v_ids);
    IF v_deleted <> 2 THEN RAISE EXCEPTION '[bulk_delete 2] expected 2 deleted, got %', v_deleted; END IF;

    -- 1 transferencia survives
    SELECT COUNT(*) INTO v_deleted FROM transactions
    WHERE user_id = v_uid AND amount = 3300;
    IF v_deleted <> 1 THEN RAISE EXCEPTION '[after bulk_delete] expected 1 surviving 3300, got %', v_deleted; END IF;

    -- bulk_delete on someone else's UUID does nothing (security)
    DECLARE other_uid UUID := gen_random_uuid();
    BEGIN
        SELECT deleted_count INTO v_deleted FROM bulk_delete_by_ids(other_uid, ARRAY(SELECT id FROM transactions WHERE user_id = v_uid LIMIT 2));
        IF v_deleted <> 0 THEN RAISE EXCEPTION '[bulk_delete cross-user] expected 0, deleted %', v_deleted; END IF;
    END;

    RAISE NOTICE 'PASS duplicates + bulk_delete';
END $$;
