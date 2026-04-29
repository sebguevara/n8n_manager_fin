-- Test: purge_old_chat_history + log_cron_start + log_cron_end
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_run_id INT;
    v_purged BIGINT;
    v_count INT;
BEGIN
    -- Insert some old + recent chat history
    INSERT INTO n8n_chat_histories (session_id, message, created_at)
    VALUES (v_uid::text, '{"type":"human","content":"old"}'::jsonb, NOW() - INTERVAL '60 days'),
           (v_uid::text, '{"type":"ai","content":"recent"}'::jsonb, NOW() - INTERVAL '10 days');

    -- Purge older than 30 days
    SELECT purge_old_chat_history(30) INTO v_purged;
    IF v_purged < 1 THEN RAISE EXCEPTION '[purge_chat] expected ≥1 purged, got %', v_purged; END IF;

    SELECT COUNT(*) INTO v_count FROM n8n_chat_histories WHERE session_id = v_uid::text;
    IF v_count <> 1 THEN RAISE EXCEPTION '[purge_chat effect] expected 1 row left, got %', v_count; END IF;

    -- Cleanup recent
    DELETE FROM n8n_chat_histories WHERE session_id = v_uid::text;

    -- Cron logging
    SELECT log_cron_start('test_cron', '{"phase":"unit_test"}'::jsonb) INTO v_run_id;
    IF v_run_id IS NULL THEN RAISE EXCEPTION '[log_cron_start] returned null'; END IF;

    PERFORM log_cron_end(v_run_id, 5, 4, true, NULL);

    -- Verify
    SELECT items_processed INTO v_count FROM cron_runs WHERE id = v_run_id;
    IF v_count <> 5 THEN RAISE EXCEPTION '[log_cron_end] items_processed wrong'; END IF;

    -- Cleanup
    DELETE FROM cron_runs WHERE id = v_run_id;

    RAISE NOTICE 'PASS chat_history + cron_log';
END $$;
