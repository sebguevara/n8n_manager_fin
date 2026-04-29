-- Test: find_best_category — exact, keyword, trigram match
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
BEGIN
    -- Exact match
    SELECT * INTO r FROM find_best_category(v_uid, 'comida', 'expense');
    IF r.match_kind <> 'exact' THEN RAISE EXCEPTION '[fbc comida] expected exact, got %', r.match_kind; END IF;

    -- Keyword match: "starbucks" → Café category (has 'starbucks' keyword)
    SELECT * INTO r FROM find_best_category(v_uid, 'starbucks', 'expense');
    IF r.category_name NOT ILIKE 'café%' THEN RAISE EXCEPTION '[fbc starbucks] expected Café, got %', r.category_name; END IF;

    -- Trigram match: "comid" (typo) → Comida
    SELECT * INTO r FROM find_best_category(v_uid, 'comid', 'expense');
    IF r.category_name NOT ILIKE 'comida' THEN RAISE EXCEPTION '[fbc typo] expected Comida, got %', r.category_name; END IF;

    -- Type respected: a comida match should NOT be returned for 'income'
    SELECT * INTO r FROM find_best_category(v_uid, 'comida', 'income');
    IF r.category_name ILIKE 'comida' THEN RAISE EXCEPTION '[fbc type filter] returned expense category for income'; END IF;

    -- Unknown random text → no match (or low score)
    SELECT * INTO r FROM find_best_category(v_uid, 'asdfqwerzxcv', 'expense');
    IF r.category_id IS NOT NULL AND r.score >= 0.5 THEN
        RAISE EXCEPTION '[fbc unknown] should not match unrelated text';
    END IF;

    RAISE NOTICE 'PASS find_best_category';
END $$;
