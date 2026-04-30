-- Test: pgvector extension + add/search/forget/list_memory_chunks
-- Cubre dedup blando, KNN con cosine, soft-delete, user isolation, kind filter.
\set ON_ERROR_STOP on

SELECT set_config('test.uid', :'uid', false);

DO $$
DECLARE
    v_uid UUID := current_setting('test.uid')::uuid;
    r RECORD;
    v_count INT;
    v_id_a UUID; v_id_b UUID; v_id_c UUID;
    v_emb_apple vector(1536);
    v_emb_orange vector(1536);
    v_emb_query vector(1536);
BEGIN
    -- Limpieza por si quedó de una corrida anterior
    DELETE FROM memory_chunks WHERE user_id = v_uid;

    -- Sanity check: pgvector cargado
    PERFORM 1 FROM pg_extension WHERE extname = 'vector';
    IF NOT FOUND THEN RAISE EXCEPTION '[ext] pgvector no instalado'; END IF;

    -- Embeddings sintéticos: vectores deterministicos para testear sin OpenAI.
    -- Los hago "casi unitarios" en distintas direcciones para que cosine los distinga.
    -- "apple" eje 0, "orange" eje 1, "query" cerca de apple (eje 0 + ruido pequeño).
    SELECT array_agg(CASE WHEN i=1 THEN 1.0 ELSE 0.0 END)::vector(1536)
      INTO v_emb_apple FROM generate_series(1, 1536) i;
    SELECT array_agg(CASE WHEN i=2 THEN 1.0 ELSE 0.0 END)::vector(1536)
      INTO v_emb_orange FROM generate_series(1, 1536) i;
    SELECT array_agg(CASE WHEN i=1 THEN 0.99 WHEN i=3 THEN 0.05 ELSE 0.0 END)::vector(1536)
      INTO v_emb_query FROM generate_series(1, 1536) i;

    -- =============================================================
    -- 1. add_memory_chunk crea chunk nuevo
    -- =============================================================
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'fact', 'el usuario es vegetariano',
        v_emb_apple, '{"source":"test"}'::jsonb
    );
    IF NOT r.was_created THEN RAISE EXCEPTION '[add 1] expected was_created=true'; END IF;
    IF r.kind <> 'fact' THEN RAISE EXCEPTION '[add 1 kind] got %', r.kind; END IF;
    v_id_a := r.id;

    -- =============================================================
    -- 2. add_memory_chunk dedupea blando (mismo embedding ≈)
    -- =============================================================
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'fact', 'es vegetariano el usuario (parafraseado)',
        v_emb_apple, '{}'::jsonb
    );
    IF r.was_created THEN RAISE EXCEPTION '[add 2 dedup] esperaba was_created=false (mismo embedding)'; END IF;
    IF r.id <> v_id_a THEN RAISE EXCEPTION '[add 2 same id] got distinct id'; END IF;

    -- =============================================================
    -- 3. add_memory_chunk con embedding distinto crea otro
    -- =============================================================
    SELECT * INTO r FROM add_memory_chunk(
        v_uid, 'preference', 'le gustan las frutas naranjas', v_emb_orange, '{}'::jsonb
    );
    IF NOT r.was_created THEN RAISE EXCEPTION '[add 3] expected new chunk'; END IF;
    v_id_b := r.id;

    -- =============================================================
    -- 4. search_memory_chunks: query cerca de "apple" → recupera v_id_a
    -- =============================================================
    -- Wave 2: search_memory_chunks ahora devuelve (id, kind, content, metadata,
    -- similarity, final_score, created_at, recall_count). final_score combina
    -- similarity + recencia + recall_count.
    SELECT id, kind, content, similarity, final_score INTO r
    FROM search_memory_chunks(v_uid, v_emb_query, 1, NULL, 0.5);
    IF r.id <> v_id_a THEN RAISE EXCEPTION '[search top] esperaba id_a, got %', r.id; END IF;
    IF r.similarity < 0.9 THEN RAISE EXCEPTION '[search similarity] esperaba >0.9 (cerca de apple), got %', r.similarity; END IF;
    -- final_score debe estar entre 0 y 1, y >= similarity*0.7 (los otros
    -- factores son no-negativos)
    IF r.final_score < r.similarity * 0.7 THEN RAISE EXCEPTION '[final_score floor] %  < %', r.final_score, r.similarity*0.7; END IF;
    IF r.final_score > 1.01 THEN RAISE EXCEPTION '[final_score ceil] % > 1', r.final_score; END IF;

    -- =============================================================
    -- 5. search con min_score alto: si subo a 0.99, no debería matchear el de orange
    -- =============================================================
    SELECT COUNT(*) INTO v_count
    FROM search_memory_chunks(v_uid, v_emb_query, 5, NULL, 0.95);
    IF v_count <> 1 THEN RAISE EXCEPTION '[search min_score 0.95] esperaba 1 (solo apple), got %', v_count; END IF;

    -- =============================================================
    -- 6. search con kind filter
    -- =============================================================
    SELECT COUNT(*) INTO v_count
    FROM search_memory_chunks(v_uid, v_emb_query, 5, 'preference', 0.0);
    IF v_count <> 1 THEN RAISE EXCEPTION '[search kind=preference] esperaba 1, got %', v_count; END IF;

    SELECT COUNT(*) INTO v_count
    FROM search_memory_chunks(v_uid, v_emb_query, 5, 'goal', 0.0);
    IF v_count <> 0 THEN RAISE EXCEPTION '[search kind=goal] esperaba 0, got %', v_count; END IF;

    -- =============================================================
    -- 7. recall_count se incrementa al buscar
    -- =============================================================
    SELECT mc.recall_count INTO v_count FROM memory_chunks mc WHERE mc.id = v_id_a;
    IF v_count < 1 THEN RAISE EXCEPTION '[recall_count] esperaba ≥1 después del search, got %', v_count; END IF;

    -- =============================================================
    -- 8. list_memory_chunks devuelve activos
    -- =============================================================
    SELECT COUNT(*) INTO v_count FROM list_memory_chunks(v_uid, NULL, 20);
    IF v_count <> 2 THEN RAISE EXCEPTION '[list all] esperaba 2, got %', v_count; END IF;

    SELECT COUNT(*) INTO v_count FROM list_memory_chunks(v_uid, 'fact', 20);
    IF v_count <> 1 THEN RAISE EXCEPTION '[list kind=fact] esperaba 1, got %', v_count; END IF;

    -- =============================================================
    -- 9. forget_memory_chunk: soft-delete
    -- =============================================================
    SELECT * INTO r FROM forget_memory_chunk(v_uid, v_id_a);
    IF NOT r.forgot THEN RAISE EXCEPTION '[forget] esperaba forgot=true'; END IF;

    -- Ya no debería aparecer en search ni list
    SELECT COUNT(*) INTO v_count FROM search_memory_chunks(v_uid, v_emb_query, 5, NULL, 0.0);
    IF v_count <> 1 THEN RAISE EXCEPTION '[search post-forget] esperaba 1 (solo orange), got %', v_count; END IF;

    SELECT COUNT(*) INTO v_count FROM list_memory_chunks(v_uid, NULL, 20);
    IF v_count <> 1 THEN RAISE EXCEPTION '[list post-forget] esperaba 1, got %', v_count; END IF;

    -- Pero sigue existiendo con kind='__forgotten__' (audit trail)
    SELECT COUNT(*) INTO v_count FROM memory_chunks WHERE id = v_id_a AND kind = '__forgotten__';
    IF v_count <> 1 THEN RAISE EXCEPTION '[forget audit] esperaba __forgotten__, got %', v_count; END IF;

    -- forget de un id ya borrado → forgot=false (idempotente)
    SELECT * INTO r FROM forget_memory_chunk(v_uid, v_id_a);
    IF r.forgot THEN RAISE EXCEPTION '[forget idempotent] segundo forget debe devolver false'; END IF;

    -- =============================================================
    -- 10. content vacío → RAISE EXCEPTION
    -- =============================================================
    BEGIN
        PERFORM add_memory_chunk(v_uid, 'fact', '   ', v_emb_apple, '{}'::jsonb);
        RAISE EXCEPTION '[add empty content] should raise';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%requeridos%' THEN RAISE EXCEPTION '[add empty] error inesperado: %', SQLERRM; END IF;
    END;

    -- =============================================================
    -- 11. Aislamiento: otro user no ve mis chunks
    -- =============================================================
    DECLARE v_other UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__other_mem', 'Other Mem') INTO v_other;
        SELECT COUNT(*) INTO v_count FROM list_memory_chunks(v_other, NULL, 20);
        IF v_count <> 0 THEN RAISE EXCEPTION '[isolation list] otro user vio %, esperaba 0', v_count; END IF;

        SELECT COUNT(*) INTO v_count FROM search_memory_chunks(v_other, v_emb_query, 5, NULL, 0.0);
        IF v_count <> 0 THEN RAISE EXCEPTION '[isolation search] otro user vio %, esperaba 0', v_count; END IF;

        -- Otro user intenta forget mi chunk → forgot=false
        SELECT * INTO r FROM forget_memory_chunk(v_other, v_id_b);
        IF r.forgot THEN RAISE EXCEPTION '[isolation forget] otro user borró mi chunk'; END IF;

        DELETE FROM users WHERE id = v_other;
    END;

    -- =============================================================
    -- 12b. update_memory_chunk: cambia content y embedding sin perder id
    -- =============================================================
    DECLARE v_emb_grape vector(1536); v_id_upd UUID;
    BEGIN
        -- Crear un chunk para actualizar
        SELECT array_agg(CASE WHEN i=10 THEN 1.0 ELSE 0.0 END)::vector(1536)
          INTO v_emb_grape FROM generate_series(1, 1536) i;
        SELECT id INTO v_id_upd FROM add_memory_chunk(
            v_uid, 'goal', 'meta inicial 4M', v_emb_grape, '{"v":1}'::jsonb
        );

        -- update con nuevo content + nuevo embedding (eje 11) y kind nuevo
        DECLARE v_emb_v2 vector(1536);
        BEGIN
            SELECT array_agg(CASE WHEN i=11 THEN 1.0 ELSE 0.0 END)::vector(1536)
              INTO v_emb_v2 FROM generate_series(1, 1536) i;
            SELECT * INTO r FROM update_memory_chunk(
                v_uid, v_id_upd, 'meta actualizada 5M', v_emb_v2, 'context', '{"v":2}'::jsonb
            );
            IF NOT r.updated THEN RAISE EXCEPTION '[update] esperaba updated=true'; END IF;
            IF r.id <> v_id_upd THEN RAISE EXCEPTION '[update] id cambió'; END IF;
            IF r.content NOT LIKE '%5M%' THEN RAISE EXCEPTION '[update content] got %', r.content; END IF;
            IF r.kind <> 'context' THEN RAISE EXCEPTION '[update kind] got %', r.kind; END IF;
        END;

        -- Verificar que metadata fue mergeada
        SELECT metadata INTO r FROM memory_chunks WHERE id = v_id_upd;
        IF (r.metadata->>'v') <> '2' THEN RAISE EXCEPTION '[update metadata] v should be 2, got %', r.metadata->>'v'; END IF;

        -- update sobre id ajeno → updated=false
        DECLARE v_other2 UUID;
        BEGIN
            SELECT bootstrap_user('__TEST__upd_iso', 'Iso') INTO v_other2;
            SELECT * INTO r FROM update_memory_chunk(
                v_other2, v_id_upd, 'hackeo', v_emb_grape, NULL, NULL
            );
            IF r.updated THEN RAISE EXCEPTION '[update isolation] otro user actualizó mi chunk'; END IF;
            DELETE FROM users WHERE id = v_other2;
        END;

        -- update con content vacío → RAISE
        BEGIN
            PERFORM update_memory_chunk(v_uid, v_id_upd, '   ', v_emb_grape, NULL, NULL);
            RAISE EXCEPTION '[update empty] should raise';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM NOT LIKE '%requeridos%' THEN RAISE; END IF;
        END;

        -- Cleanup este chunk
        DELETE FROM memory_chunks WHERE id = v_id_upd;
    END;

    -- =============================================================
    -- 13. CASCADE: borrar el user borra los chunks
    -- =============================================================
    DECLARE v_temp UUID;
    BEGIN
        SELECT bootstrap_user('__TEST__cascade_mem', 'Cascade') INTO v_temp;
        PERFORM add_memory_chunk(v_temp, 'fact', 'temporal', v_emb_apple, '{}'::jsonb);

        SELECT COUNT(*) INTO v_count FROM memory_chunks WHERE user_id = v_temp;
        IF v_count <> 1 THEN RAISE EXCEPTION '[cascade pre] esperaba 1, got %', v_count; END IF;

        DELETE FROM users WHERE id = v_temp;

        SELECT COUNT(*) INTO v_count FROM memory_chunks WHERE user_id = v_temp;
        IF v_count <> 0 THEN RAISE EXCEPTION '[cascade post] esperaba 0, got %', v_count; END IF;
    END;

    -- Cleanup
    DELETE FROM memory_chunks WHERE user_id = v_uid;

    RAISE NOTICE 'PASS memory_chunks (13 escenarios + update_memory_chunk)';
END $$;
