-- Test: bulk_preview
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
BEGIN
    -- preview "all this_month" → should match remaining txs after the previous bulk_delete (3 left this month)
    SELECT * INTO r FROM bulk_preview(v_uid, '{"period":"this_month","type":"expense"}'::jsonb);
    IF r.would_match_count <> 3 THEN RAISE EXCEPTION '[bulk_preview this_month] expected 3, got %', r.would_match_count; END IF;
    IF r.would_match_total <> 7300 THEN -- 2000 + 2000 + 3300 (1 remaining transferencia)
        RAISE EXCEPTION '[bulk_preview total] expected 7300, got %', r.would_match_total;
    END IF;
    IF array_length(r.sample_ids, 1) <> 3 THEN
        RAISE EXCEPTION '[bulk_preview sample_ids] expected 3 ids, got %', array_length(r.sample_ids, 1);
    END IF;

    -- preview by description "café" → 2 cafés
    SELECT * INTO r FROM bulk_preview(v_uid, '{"period":"all","description_contains":"café"}'::jsonb);
    IF r.would_match_count <> 2 THEN RAISE EXCEPTION '[bulk_preview café] expected 2, got %', r.would_match_count; END IF;

    RAISE NOTICE 'PASS bulk_preview';
END $$;
