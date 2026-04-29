-- Test: set_conv_state + get_user_state + clear_conv_state + purge_expired_conv_states
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    r RECORD;
BEGIN
    -- Set state with context
    PERFORM set_conv_state(v_uid, 'awaiting_category', '{"amount":3300,"description":"transferencia"}'::jsonb, 600);

    -- Get it back (function returns conv_state, conv_context)
    SELECT * INTO r FROM get_user_state(v_uid);
    IF r.conv_state <> 'awaiting_category' THEN RAISE EXCEPTION '[get_state] got %', r.conv_state; END IF;
    IF r.conv_context->>'amount' <> '3300' THEN RAISE EXCEPTION '[get_state context]'; END IF;

    -- Update with new state
    PERFORM set_conv_state(v_uid, 'awaiting_bulk_delete', '{"ids":["a","b"]}'::jsonb, 300);
    SELECT * INTO r FROM get_user_state(v_uid);
    IF r.conv_state <> 'awaiting_bulk_delete' THEN RAISE EXCEPTION '[update state]'; END IF;
    IF jsonb_array_length(r.conv_context->'ids') <> 2 THEN RAISE EXCEPTION '[update state ctx]'; END IF;

    -- Clear
    PERFORM clear_conv_state(v_uid);
    SELECT COUNT(*) INTO v_count FROM conversation_state WHERE user_id = v_uid;
    IF v_count <> 0 THEN RAISE EXCEPTION '[clear] state remains'; END IF;

    -- Insert expired state, then purge
    INSERT INTO conversation_state (user_id, state, context, expires_at)
    VALUES (v_uid, 'old', '{}'::jsonb, NOW() - INTERVAL '2 hours');

    DECLARE v_purged BIGINT;
    BEGIN
        SELECT purge_expired_conv_states() INTO v_purged;
        IF v_purged < 1 THEN RAISE EXCEPTION '[purge] expected ≥1 purged, got %', v_purged; END IF;
    END;

    SELECT COUNT(*) INTO v_count FROM conversation_state WHERE user_id = v_uid;
    IF v_count <> 0 THEN RAISE EXCEPTION '[purge effect] expired state still here'; END IF;

    RAISE NOTICE 'PASS conv_state + purge';
END $$;
