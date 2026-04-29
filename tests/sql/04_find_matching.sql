-- Test: find_matching_tx_v2 — catches the "borró el café equivocado" bug
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    r RECORD;
BEGIN
    -- exact_amount=3300 → 3 matches, all with exact_amount reason
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(v_uid, NULL,NULL,NULL,NULL, 3300, NULL,NULL, NULL,NULL,NULL, 20);
    IF v_count <> 3 THEN RAISE EXCEPTION '[find exact 3300] expected 3, got %', v_count; END IF;

    -- exact_amount + date → still 3 (same day)
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(
        v_uid, NULL,
        DATE_TRUNC('month', CURRENT_DATE)::DATE + 2,
        NULL, NULL,
        3300, NULL, NULL,
        NULL, NULL, NULL, 20
    );
    IF v_count <> 3 THEN RAISE EXCEPTION '[find exact 3300+date] expected 3, got %', v_count; END IF;

    -- description hint "café" with no other filters → only matches cafés (NOT transferencias)
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(
        v_uid, 'café', NULL,NULL,NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 20
    );
    IF v_count <> 2 THEN RAISE EXCEPTION '[find desc café] expected 2 (the cafés), got %', v_count; END IF;

    -- description hint "maxi" → only the 3 transferencias
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(
        v_uid, 'maxi', NULL,NULL,NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 20
    );
    IF v_count <> 3 THEN RAISE EXCEPTION '[find desc maxi] expected 3, got %', v_count; END IF;

    -- combo: amount=3300 (deterministic) + desc=cafe → AMOUNT WINS, returns 3 transferencias
    -- (cafe trigram doesn't matter because date/amount are AND filters)
    SELECT COUNT(*) INTO v_count FROM find_matching_tx_v2(
        v_uid, 'cafe', NULL, NULL, NULL,
        3300, NULL, NULL, NULL, NULL, NULL, 20
    );
    IF v_count <> 3 THEN RAISE EXCEPTION '[find amount+desc] hard filter (amount) should win, expected 3, got %', v_count; END IF;

    -- match_reasons.exact_amount=true for the 3300 query
    FOR r IN SELECT * FROM find_matching_tx_v2(v_uid, NULL,NULL,NULL,NULL, 3300, NULL,NULL,NULL,NULL,NULL, 20) LOOP
        IF (r.match_reasons->>'exact_amount')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION '[find match_reasons] exact_amount should be true';
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS find_matching_tx_v2';
END $$;
