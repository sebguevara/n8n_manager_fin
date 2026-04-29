-- Test: bootstrap_user — seeds default categories + payment methods + idempotent
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_other_phone TEXT := '__TEST__OTHER_USER__';
    v_other_uid UUID;
    v_cat_count INT;
    v_pm_count INT;
BEGIN
    -- Bootstrap a fresh different user
    DELETE FROM users WHERE phone_number = v_other_phone;
    SELECT bootstrap_user(v_other_phone, 'Other User') INTO v_other_uid;

    IF v_other_uid IS NULL THEN RAISE EXCEPTION '[bootstrap] returned NULL'; END IF;

    -- Should have seeded default categories
    SELECT COUNT(*) INTO v_cat_count FROM categories WHERE user_id = v_other_uid;
    IF v_cat_count < 5 THEN RAISE EXCEPTION '[bootstrap] expected ≥5 default categories, got %', v_cat_count; END IF;

    -- Should have seeded payment methods
    SELECT COUNT(*) INTO v_pm_count FROM payment_methods WHERE user_id = v_other_uid;
    IF v_pm_count < 3 THEN RAISE EXCEPTION '[bootstrap] expected ≥3 default payment methods, got %', v_pm_count; END IF;

    -- Idempotent: calling again returns SAME uid
    DECLARE v_again UUID;
    BEGIN
        SELECT bootstrap_user(v_other_phone, 'Other User Renamed') INTO v_again;
        IF v_again <> v_other_uid THEN RAISE EXCEPTION '[bootstrap] not idempotent: % vs %', v_again, v_other_uid; END IF;
    END;

    -- Cleanup the second user
    DELETE FROM users WHERE id = v_other_uid;

    RAISE NOTICE 'PASS bootstrap_user';
END $$;
