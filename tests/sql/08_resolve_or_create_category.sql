-- Test: resolve_or_create_category — for the ambiguity flow
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_count INT;
BEGIN
    -- Existing exact match: 'comida'
    SELECT * INTO r FROM resolve_or_create_category(v_uid, 'comida', 'expense');
    IF r.was_created THEN RAISE EXCEPTION '[resolve comida] should NOT create existing'; END IF;
    IF r.category_name NOT ILIKE 'comida' THEN RAISE EXCEPTION '[resolve comida] expected Comida, got %', r.category_name; END IF;

    -- Fuzzy match: 'comidas' (plural) → matches 'Comida'
    SELECT * INTO r FROM resolve_or_create_category(v_uid, 'comidas', 'expense');
    IF r.was_created THEN RAISE EXCEPTION '[resolve comidas] should fuzzy-match Comida, not create'; END IF;

    -- New category: 'familia' → creates
    SELECT * INTO r FROM resolve_or_create_category(v_uid, 'familia', 'expense');
    IF NOT r.was_created THEN RAISE EXCEPTION '[resolve familia] should create new'; END IF;
    IF r.category_name NOT ILIKE 'familia' THEN RAISE EXCEPTION '[resolve familia] name=%', r.category_name; END IF;

    -- Calling resolve again with 'familia' should find the just-created one
    SELECT * INTO r FROM resolve_or_create_category(v_uid, 'familia', 'expense');
    IF r.was_created THEN RAISE EXCEPTION '[resolve familia 2nd] should now find, not create again'; END IF;

    -- Verify category exists in DB
    SELECT COUNT(*) INTO v_count FROM categories WHERE user_id = v_uid AND normalized_name = 'familia';
    IF v_count <> 1 THEN RAISE EXCEPTION '[resolve familia DB] expected 1 row, got %', v_count; END IF;

    RAISE NOTICE 'PASS resolve_or_create_category';
END $$;
