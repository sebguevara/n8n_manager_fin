-- Test: delete_budget + pause_budget + resume_budget
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    v_count INT;
    r RECORD;
BEGIN
    -- Crear presupuesto base
    PERFORM set_budget(v_uid, 'comida', 50000, 'monthly');

    -- Verificar que existe y está activo
    SELECT COUNT(*) INTO v_count FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = v_uid AND c.normalized_name = 'comida'
      AND b.period = 'monthly' AND b.is_active;
    IF v_count <> 1 THEN RAISE EXCEPTION '[setup] expected 1 active budget, got %', v_count; END IF;

    -- pause_budget
    SELECT * INTO r FROM pause_budget(v_uid, 'comida', 'monthly');
    IF r.paused_count <> 1 THEN RAISE EXCEPTION '[pause_budget] expected 1, got %', r.paused_count; END IF;

    -- Verificar que está pausado (qualify cols: ambas tablas tienen is_active)
    SELECT b.is_active AS is_active INTO r FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = v_uid AND c.normalized_name = 'comida' AND b.period = 'monthly';
    IF r.is_active THEN RAISE EXCEPTION '[pause effect] should be inactive'; END IF;

    -- pause sobre uno ya pausado → 0
    SELECT * INTO r FROM pause_budget(v_uid, 'comida', 'monthly');
    IF r.paused_count <> 0 THEN RAISE EXCEPTION '[pause idempotent] expected 0, got %', r.paused_count; END IF;

    -- resume_budget
    SELECT * INTO r FROM resume_budget(v_uid, 'comida', 'monthly');
    IF r.resumed_count <> 1 THEN RAISE EXCEPTION '[resume_budget] expected 1, got %', r.resumed_count; END IF;

    -- delete_budget
    SELECT * INTO r FROM delete_budget(v_uid, 'comida', 'monthly');
    IF r.deleted_count <> 1 THEN RAISE EXCEPTION '[delete_budget] expected 1, got %', r.deleted_count; END IF;
    IF r.category_name IS NULL THEN RAISE EXCEPTION '[delete_budget] no category_name'; END IF;

    -- Verificar que ya no existe
    SELECT COUNT(*) INTO v_count FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = v_uid AND c.normalized_name = 'comida' AND b.period = 'monthly';
    IF v_count <> 0 THEN RAISE EXCEPTION '[delete effect] still exists'; END IF;

    -- delete sobre categoría sin budget → 0 (no error)
    SELECT * INTO r FROM delete_budget(v_uid, 'comida', 'monthly');
    IF r.deleted_count <> 0 THEN RAISE EXCEPTION '[delete already gone] expected 0'; END IF;

    -- delete con period=NULL borra todos los periodos
    PERFORM set_budget(v_uid, 'comida', 50000, 'monthly');
    PERFORM set_budget(v_uid, 'comida', 12000, 'weekly');
    SELECT * INTO r FROM delete_budget(v_uid, 'comida', NULL);
    IF r.deleted_count <> 2 THEN RAISE EXCEPTION '[delete all periods] expected 2, got %', r.deleted_count; END IF;

    -- delete con categoría inexistente → 0
    SELECT * INTO r FROM delete_budget(v_uid, '__no_existe_zzz__', NULL);
    IF r.deleted_count <> 0 THEN RAISE EXCEPTION '[delete bad cat] expected 0'; END IF;

    -- Aislamiento
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_bud', 'Other Bud') INTO v_other;
        PERFORM set_budget(v_uid, 'comida', 33000, 'monthly');
        SELECT * INTO r FROM delete_budget(v_other, 'comida', 'monthly');
        IF r.deleted_count > 0 THEN RAISE EXCEPTION '[isolation] otro user borró mi budget'; END IF;
        DELETE FROM users WHERE id = v_other;
    END;

    -- Cleanup
    PERFORM delete_budget(v_uid, 'comida', NULL);

    RAISE NOTICE 'PASS budgets CRUD';
END $$;
