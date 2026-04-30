-- Test: get_user_settings + update_user_settings
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
BEGIN
    -- Setup defensivo: empezamos desde valores conocidos
    PERFORM update_user_settings(v_uid, 'Test User', 'ARS', TRUE, 22, TRUE);

    -- get_user_settings: defaults
    SELECT * INTO r FROM get_user_settings(v_uid);
    IF r.preferred_currency <> 'ARS' THEN RAISE EXCEPTION '[get default currency] got %', r.preferred_currency; END IF;
    IF r.daily_summary_hour < 0 OR r.daily_summary_hour > 23 THEN
        RAISE EXCEPTION '[get default hour] out of range: %', r.daily_summary_hour;
    END IF;

    -- update solo currency
    SELECT * INTO r FROM update_user_settings(v_uid, NULL, 'USD', NULL, NULL, NULL);
    IF r.preferred_currency <> 'USD' THEN RAISE EXCEPTION '[update currency] got %', r.preferred_currency; END IF;

    -- update hora válida
    SELECT * INTO r FROM update_user_settings(v_uid, NULL, NULL, NULL, 8, NULL);
    IF r.daily_summary_hour <> 8 THEN RAISE EXCEPTION '[update hour] got %', r.daily_summary_hour; END IF;

    -- update hora inválida → RAISE
    BEGIN
        PERFORM update_user_settings(v_uid, NULL, NULL, NULL, 25, NULL);
        RAISE EXCEPTION '[update bad hour] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%entre 0 y 23%' THEN RAISE; END IF;
    END;

    -- update flags
    SELECT * INTO r FROM update_user_settings(v_uid, NULL, NULL, FALSE, NULL, FALSE);
    IF r.daily_summary_enabled THEN RAISE EXCEPTION '[update daily_enabled] should be false'; END IF;
    IF r.weekly_summary_enabled THEN RAISE EXCEPTION '[update weekly_enabled] should be false'; END IF;

    -- update name preserva otros campos
    SELECT * INTO r FROM update_user_settings(v_uid, 'Nombre Cambiado', NULL, NULL, NULL, NULL);
    IF r.name <> 'Nombre Cambiado' THEN RAISE EXCEPTION '[update name] got %', r.name; END IF;
    IF r.preferred_currency <> 'USD' THEN RAISE EXCEPTION '[update name preserved currency] got %', r.preferred_currency; END IF;
    IF r.daily_summary_hour <> 8 THEN RAISE EXCEPTION '[update name preserved hour] got %', r.daily_summary_hour; END IF;

    -- get reflects updates
    SELECT * INTO r FROM get_user_settings(v_uid);
    IF r.name <> 'Nombre Cambiado' THEN RAISE EXCEPTION '[get after update name] got %', r.name; END IF;
    IF r.daily_summary_enabled THEN RAISE EXCEPTION '[get after update daily] should be false'; END IF;

    -- Aislamiento: otro user no puede tocar mis settings
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_set', 'Other Set') INTO v_other;
        -- Otro user updatea sus propios settings
        PERFORM update_user_settings(v_other, 'Otro', 'EUR', NULL, NULL, NULL);
        SELECT * INTO r FROM get_user_settings(v_uid);
        IF r.preferred_currency <> 'USD' THEN RAISE EXCEPTION '[isolation] otro user afectó mi currency'; END IF;
        IF r.name <> 'Nombre Cambiado' THEN RAISE EXCEPTION '[isolation] otro user afectó mi name'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup: restaurar valores originales
    PERFORM update_user_settings(v_uid, 'Test User', 'ARS', TRUE, 22, TRUE);

    RAISE NOTICE 'PASS user settings';
END $$;
