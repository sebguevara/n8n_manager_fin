-- Test: ola de robustez de memoria
--   - search_memory_chunks: ranking híbrido (recency + recall_count afectan)
--   - memory_chunk_versions: audit log de create/update/forget/stale/reembed
--   - add_memory_chunk: detección de contradicciones (sim 0.85-0.94) + source
--   - mark_stale_memories: marca facts viejos sin uso
--   - export_user_memory / export_all_memory: snapshot serializable
--   - reembed_memory_chunk: cambia embedding sin tocar content
--   - find_contradiction_candidates: facts cercanos pero no duplicados
--   - set_conv_state versionado + set_conv_state_if_match (optimistic lock)

\set ON_ERROR_STOP on
SELECT set_config('test.uid', :'uid', false);

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_count INT;
    v_id_a UUID; v_id_b UUID; v_id_c UUID;
    v_emb_a vector(1536);
    v_emb_b vector(1536);
    v_emb_close vector(1536);   -- cerca de v_emb_a (0.85-0.94 — contradicción)
    v_emb_dup vector(1536);     -- casi igual a v_emb_a (0.95+ → dedup)
    v_version INT;
BEGIN
    -- Limpieza
    DELETE FROM memory_chunks WHERE user_id = v_uid;
    DELETE FROM memory_chunk_versions WHERE user_id = v_uid;
    PERFORM clear_conv_state(v_uid);

    -- Embeddings:
    --   a = eje 1
    --   b = eje 100 (lejos de a)
    --   close_to_a = a + componente pequeño en eje 2 (sim ~0.91)
    --   dup_a = a + componente muy chico en eje 3 (sim ~0.99)
    SELECT array_agg(CASE WHEN i=1 THEN 1.0 ELSE 0.0 END)::vector(1536)
      INTO v_emb_a FROM generate_series(1, 1536) i;
    SELECT array_agg(CASE WHEN i=100 THEN 1.0 ELSE 0.0 END)::vector(1536)
      INTO v_emb_b FROM generate_series(1, 1536) i;
    SELECT array_agg(CASE WHEN i=1 THEN 1.0 WHEN i=2 THEN 0.5 ELSE 0.0 END)::vector(1536)
      INTO v_emb_close FROM generate_series(1, 1536) i;
    SELECT array_agg(CASE WHEN i=1 THEN 1.0 WHEN i=3 THEN 0.05 ELSE 0.0 END)::vector(1536)
      INTO v_emb_dup FROM generate_series(1, 1536) i;

    -- =============================================================
    -- 1. add_memory_chunk crea chunk con source/model + audit row v=1
    -- =============================================================
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'fact', 'el usuario hace yoga los lunes',
        v_emb_a, '{}'::jsonb, 'user', 'text-embedding-3-small'
    );
    IF NOT r.was_created THEN RAISE EXCEPTION '[add a] expected was_created'; END IF;
    IF cardinality(r.contradicts) <> 0 THEN RAISE EXCEPTION '[add a contradicts] esperaba 0, got %', cardinality(r.contradicts); END IF;
    v_id_a := r.id;

    -- Verificar que se escribió audit row v=1
    SELECT version, operation, operation_source INTO r
    FROM memory_chunk_versions WHERE chunk_id = v_id_a ORDER BY version;
    IF r.version <> 1 THEN RAISE EXCEPTION '[audit v1] esperaba version=1, got %', r.version; END IF;
    IF r.operation <> 'create' THEN RAISE EXCEPTION '[audit op] esperaba create, got %', r.operation; END IF;
    IF r.operation_source <> 'user' THEN RAISE EXCEPTION '[audit src] esperaba user, got %', r.operation_source; END IF;

    -- Verificar que se setea embedding_model y metadata.source
    DECLARE v_model TEXT; v_source TEXT;
    BEGIN
        SELECT embedding_model, metadata->>'source' INTO v_model, v_source
        FROM memory_chunks WHERE id = v_id_a;
        IF v_model <> 'text-embedding-3-small' THEN RAISE EXCEPTION '[model col] got %', v_model; END IF;
        IF v_source <> 'user' THEN RAISE EXCEPTION '[meta source] got %', v_source; END IF;
    END;

    -- =============================================================
    -- 2. add_memory_chunk dedup (sim>=0.95) — bumpea recall, no crea audit nuevo
    -- =============================================================
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'fact', 'yoga lunes (parafraseado)',
        v_emb_dup, '{}'::jsonb, 'user', 'text-embedding-3-small'
    );
    IF r.was_created THEN RAISE EXCEPTION '[dedup] esperaba was_created=false'; END IF;
    IF r.id <> v_id_a THEN RAISE EXCEPTION '[dedup same id]'; END IF;

    -- Audit: solo debería haber una row (v=1) — el dedup NO crea v=2
    SELECT COUNT(*) INTO v_count FROM memory_chunk_versions WHERE chunk_id = v_id_a;
    IF v_count <> 1 THEN RAISE EXCEPTION '[dedup audit] esperaba 1 row, got %', v_count; END IF;

    -- =============================================================
    -- 3. add_memory_chunk con sim 0.85-0.94 → CREA + devuelve contradicts
    -- =============================================================
    -- v_emb_close vs v_emb_a: sim ~0.89 (1/sqrt(1.25))
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'fact', 'el usuario va al gym los lunes (no yoga)',
        v_emb_close, '{}'::jsonb, 'user', 'text-embedding-3-small'
    );
    IF NOT r.was_created THEN RAISE EXCEPTION '[contradiction add] esperaba was_created=true'; END IF;
    IF cardinality(r.contradicts) <> 1 THEN RAISE EXCEPTION '[contradiction list] esperaba 1, got %', cardinality(r.contradicts); END IF;
    IF r.contradicts[1] <> v_id_a THEN RAISE EXCEPTION '[contradiction id] no apunta a v_id_a'; END IF;
    v_id_c := r.id;

    -- Verificar metadata.contradicts_ids quedó persistido
    DECLARE v_contra JSONB;
    BEGIN
        SELECT metadata->'contradicts_ids' INTO v_contra FROM memory_chunks WHERE id = v_id_c;
        IF v_contra IS NULL THEN RAISE EXCEPTION '[meta contradicts]'; END IF;
    END;

    -- =============================================================
    -- 4. find_contradiction_candidates encuentra el cercano sin dedup
    -- =============================================================
    SELECT COUNT(*) INTO v_count
    FROM find_contradiction_candidates(v_uid, v_emb_a, 5);
    -- v_id_c está cerca de v_emb_a (sim 0.89) → debería aparecer.
    -- v_id_a se excluye porque sim=1.0 (es duplicado)
    IF v_count <> 1 THEN RAISE EXCEPTION '[find_contradiction] esperaba 1, got %', v_count; END IF;

    -- =============================================================
    -- 5. update_memory_chunk crea audit row v=2 con estado VIEJO
    -- =============================================================
    DECLARE v_emb_v2 vector(1536);
    BEGIN
        SELECT array_agg(CASE WHEN i=200 THEN 1.0 ELSE 0.0 END)::vector(1536)
          INTO v_emb_v2 FROM generate_series(1, 1536) i;
        PERFORM update_memory_chunk(v_uid, v_id_a, 'el usuario ahora hace pilates',
                                     v_emb_v2, NULL, NULL, 'user');
    END;

    -- Debe haber 2 rows en versions: v=1 (create con yoga) y v=2 (update con yoga viejo)
    SELECT COUNT(*) INTO v_count FROM memory_chunk_versions WHERE chunk_id = v_id_a;
    IF v_count <> 2 THEN RAISE EXCEPTION '[update audit count] esperaba 2, got %', v_count; END IF;

    -- v=2 debería tener el content VIEJO (yoga), no el nuevo (pilates)
    SELECT content, operation INTO r FROM memory_chunk_versions
        WHERE chunk_id = v_id_a AND version = 2;
    IF r.content NOT LIKE '%yoga%' THEN RAISE EXCEPTION '[update audit content] esperaba yoga, got %', r.content; END IF;
    IF r.operation <> 'update' THEN RAISE EXCEPTION '[update audit op]'; END IF;

    -- El estado actual del chunk SÍ debe tener pilates
    SELECT content INTO r FROM memory_chunks WHERE id = v_id_a;
    IF r.content NOT LIKE '%pilates%' THEN RAISE EXCEPTION '[update current state]'; END IF;

    -- =============================================================
    -- 6. forget_memory_chunk crea audit con operation='forget'
    -- =============================================================
    PERFORM forget_memory_chunk(v_uid, v_id_c, 'user');

    SELECT operation, content INTO r FROM memory_chunk_versions
        WHERE chunk_id = v_id_c ORDER BY version DESC LIMIT 1;
    IF r.operation <> 'forget' THEN RAISE EXCEPTION '[forget audit op] got %', r.operation; END IF;
    -- El audit debería tener el content de antes del forget (gym), no '__forgotten__'
    IF r.content NOT LIKE '%gym%' THEN RAISE EXCEPTION '[forget audit content] esperaba gym, got %', r.content; END IF;

    -- =============================================================
    -- 7. Hybrid ranking — recall_count afecta el orden cuando similarity es similar
    -- =============================================================
    DELETE FROM memory_chunks WHERE user_id = v_uid;
    DELETE FROM memory_chunk_versions WHERE user_id = v_uid;

    -- Dos chunks con similarity casi idéntica al query, pero recall_count distinto
    DECLARE v_emb_x1 vector(1536); v_emb_x2 vector(1536); v_emb_q vector(1536);
            v_id_x1 UUID; v_id_x2 UUID;
    BEGIN
        SELECT array_agg(CASE WHEN i=500 THEN 1.0 WHEN i=501 THEN 0.01 ELSE 0.0 END)::vector(1536)
          INTO v_emb_x1 FROM generate_series(1, 1536) i;
        SELECT array_agg(CASE WHEN i=500 THEN 1.0 WHEN i=502 THEN 0.01 ELSE 0.0 END)::vector(1536)
          INTO v_emb_x2 FROM generate_series(1, 1536) i;
        SELECT array_agg(CASE WHEN i=500 THEN 1.0 ELSE 0.0 END)::vector(1536)
          INTO v_emb_q FROM generate_series(1, 1536) i;

        SELECT id INTO v_id_x1 FROM add_memory_chunk(v_uid, 'fact', 'low recall fact',
            v_emb_x1, '{}'::jsonb, 'user', 'text-embedding-3-small');
        SELECT id INTO v_id_x2 FROM add_memory_chunk(v_uid, 'fact', 'high recall fact',
            v_emb_x2, '{}'::jsonb, 'user', 'text-embedding-3-small');

        -- Boost manual: simulamos 30 recalls al x2 para que recall_factor lo empuje arriba
        UPDATE memory_chunks SET recall_count = 30, last_recalled_at = NOW()
            WHERE id = v_id_x2;

        -- Buscar — el orden debe priorizar x2 aunque la similarity sea ~igual
        SELECT id, recall_count INTO r
        FROM search_memory_chunks(v_uid, v_emb_q, 1, NULL, 0.5);
        IF r.id <> v_id_x2 THEN
            RAISE EXCEPTION '[hybrid recall] esperaba que high-recall ganara, got id %', r.id;
        END IF;

        -- Cleanup este sub-test
        DELETE FROM memory_chunks WHERE user_id = v_uid;
    END;

    -- =============================================================
    -- 8. mark_stale_memories — marca facts viejos sin uso
    -- =============================================================
    -- Insertamos un fact "viejo" (created_at hace 90 días, nunca recuperado)
    INSERT INTO memory_chunks
        (user_id, kind, content, embedding, embedding_model, created_at, last_recalled_at, recall_count)
    VALUES
        (v_uid, 'fact', 'fact viejo sin uso', v_emb_a, 'text-embedding-3-small',
         NOW() - INTERVAL '90 days', NULL, 0),
        (v_uid, 'fact', 'fact reciente, no debe marcarse', v_emb_b, 'text-embedding-3-small',
         NOW() - INTERVAL '5 days', NULL, 0);

    SELECT COUNT(*) INTO v_count FROM mark_stale_memories(v_uid, 45, 60);
    IF v_count <> 1 THEN RAISE EXCEPTION '[stale marked] esperaba 1, got %', v_count; END IF;

    -- El fact viejo ahora debe tener kind='__stale__'
    SELECT kind INTO r FROM memory_chunks WHERE content = 'fact viejo sin uso';
    IF r.kind <> '__stale__' THEN RAISE EXCEPTION '[stale kind] got %', r.kind; END IF;

    -- El reciente NO debe ser tocado
    SELECT kind INTO r FROM memory_chunks WHERE content = 'fact reciente, no debe marcarse';
    IF r.kind <> 'fact' THEN RAISE EXCEPTION '[stale spared] got %', r.kind; END IF;

    -- search_memory_chunks debería excluir __stale__
    SELECT COUNT(*) INTO v_count FROM search_memory_chunks(v_uid, v_emb_a, 5, NULL, 0.0);
    -- Solo el reciente (sim baja) debería volver — el viejo está __stale__.
    -- En realidad sim de v_emb_a vs v_emb_b es 0 (vectores ortogonales) y vs el
    -- viejo era 1.0 pero ahora está stale. → 0 matches con min_score 0.0 si
    -- no hay nada con sim ≥ 0. Veamos: v_emb_b está en eje 100, v_emb_a en eje 1.
    -- Cosine = 0 (ortogonales). Con min_score=0.0 entra igual.
    IF v_count > 1 THEN RAISE EXCEPTION '[stale excluded from search] vio el stale, esperaba <=1'; END IF;

    -- =============================================================
    -- 9. export_user_memory / export_all_memory
    -- =============================================================
    DECLARE v_cnt INT; v_arr_len INT; v_chunk JSONB;
    BEGIN
        -- export incluye stale (backup completo, solo excluye __forgotten__).
        -- 2 chunks: el __stale__ y el reciente. La idea es que el snapshot
        -- preserve TODO lo que sea recuperable — stale es soft-deletion blanda.
        SELECT chunk_count INTO v_cnt FROM export_user_memory(v_uid);
        IF v_cnt <> 2 THEN RAISE EXCEPTION '[export count] esperaba 2, got %', v_cnt; END IF;

        SELECT jsonb_array_length(chunks) INTO v_arr_len FROM export_user_memory(v_uid);
        IF v_arr_len <> 2 THEN RAISE EXCEPTION '[export jsonb len]'; END IF;

        SELECT chunks->0 INTO v_chunk FROM export_user_memory(v_uid);
        IF v_chunk->>'id' IS NULL THEN RAISE EXCEPTION '[export.id]'; END IF;
        IF v_chunk->>'embedding_model' IS NULL THEN RAISE EXCEPTION '[export.model]'; END IF;
        IF v_chunk->>'content' IS NULL THEN RAISE EXCEPTION '[export.content]'; END IF;
    END;

    -- =============================================================
    -- 10. reembed_memory_chunk — cambia embedding + crea audit row
    -- =============================================================
    DECLARE v_id_re UUID; v_emb_new vector(1536);
    BEGIN
        SELECT id INTO v_id_re FROM memory_chunks
            WHERE user_id = v_uid AND content = 'fact reciente, no debe marcarse';

        SELECT array_agg(CASE WHEN i=999 THEN 1.0 ELSE 0.0 END)::vector(1536)
          INTO v_emb_new FROM generate_series(1, 1536) i;

        PERFORM reembed_memory_chunk(v_uid, v_id_re, v_emb_new, 'text-embedding-3-large', 'cron:reembed');

        -- El chunk ahora debe tener el modelo nuevo
        DECLARE v_model TEXT;
        BEGIN
            SELECT embedding_model INTO v_model FROM memory_chunks WHERE id = v_id_re;
            IF v_model <> 'text-embedding-3-large' THEN
                RAISE EXCEPTION '[reembed model] got %', v_model;
            END IF;
        END;

        -- El audit debe tener operation='reembed' y el modelo viejo en metadata
        DECLARE v_op TEXT; v_prev_model TEXT;
        BEGIN
            SELECT operation, metadata->>'prev_embedding_model' INTO v_op, v_prev_model
            FROM memory_chunk_versions
            WHERE chunk_id = v_id_re ORDER BY version DESC LIMIT 1;
            IF v_op <> 'reembed' THEN RAISE EXCEPTION '[reembed audit op] got %', v_op; END IF;
            IF v_prev_model <> 'text-embedding-3-small' THEN
                RAISE EXCEPTION '[reembed prev model] got %', v_prev_model;
            END IF;
        END;
    END;

    -- =============================================================
    -- 11. set_conv_state ahora bumpea version
    -- =============================================================
    PERFORM clear_conv_state(v_uid);

    SELECT set_conv_state(v_uid, 'state1', '{}'::jsonb, 300) INTO v_version;
    IF v_version <> 1 THEN RAISE EXCEPTION '[conv v1] got %', v_version; END IF;

    SELECT set_conv_state(v_uid, 'state2', '{}'::jsonb, 300) INTO v_version;
    IF v_version <> 2 THEN RAISE EXCEPTION '[conv v2] got %', v_version; END IF;

    SELECT set_conv_state(v_uid, 'state3', '{}'::jsonb, 300) INTO v_version;
    IF v_version <> 3 THEN RAISE EXCEPTION '[conv v3] got %', v_version; END IF;

    -- =============================================================
    -- 12. set_conv_state_if_match — optimistic lock
    -- =============================================================
    -- Estamos en version=3. Llamada con expected=3 debe ganar y devolver 4.
    SELECT set_conv_state_if_match(v_uid, 'updated', '{"key":"v"}'::jsonb, 300, 3) INTO v_version;
    IF v_version <> 4 THEN RAISE EXCEPTION '[opt lock match] got %', v_version; END IF;

    -- Llamada con expected=3 (stale) ahora debe perder → devolver -1
    SELECT set_conv_state_if_match(v_uid, 'should_lose', '{}'::jsonb, 300, 3) INTO v_version;
    IF v_version <> -1 THEN RAISE EXCEPTION '[opt lock stale] esperaba -1, got %', v_version; END IF;

    -- El estado NO debió cambiar — sigue siendo 'updated'
    SELECT state INTO r FROM conversation_state WHERE user_id = v_uid;
    IF r.state <> 'updated' THEN RAISE EXCEPTION '[opt lock preserve] got %', r.state; END IF;

    -- expected=0 (fresh insert) cuando ya hay row → debe perder
    SELECT set_conv_state_if_match(v_uid, 'fresh', '{}'::jsonb, 300, 0) INTO v_version;
    IF v_version <> -1 THEN RAISE EXCEPTION '[opt lock fresh-when-exists] esperaba -1, got %', v_version; END IF;

    -- expected=0 cuando NO hay row → debe ganar
    PERFORM clear_conv_state(v_uid);
    SELECT set_conv_state_if_match(v_uid, 'fresh', '{}'::jsonb, 300, 0) INTO v_version;
    IF v_version <> 1 THEN RAISE EXCEPTION '[opt lock fresh-when-empty] got %', v_version; END IF;

    -- Cleanup
    DELETE FROM memory_chunks WHERE user_id = v_uid;
    DELETE FROM memory_chunk_versions WHERE user_id = v_uid;
    PERFORM clear_conv_state(v_uid);

    RAISE NOTICE 'PASS memory_robustness (12 escenarios: hybrid + audit + stale + export + reembed + optimistic lock)';
END $$;
