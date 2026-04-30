-- =====================================================================
-- Expense Bot Schema — runs against the `expenses` database
-- PostgreSQL 18.x
-- =====================================================================

\connect expenses;

-- ---------- Extensions ----------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy text matching for categories
CREATE EXTENSION IF NOT EXISTS unaccent;    -- accent-insensitive matching

-- ---------- Helper: updated_at trigger ----------
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- Helper: normalize text (lowercase, no accents, trimmed) ----------
CREATE OR REPLACE FUNCTION normalize_text(t TEXT)
RETURNS TEXT AS $$
    SELECT lower(trim(unaccent(coalesce(t, ''))));
$$ LANGUAGE SQL IMMUTABLE;

-- =====================================================================
-- 1. users
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number    TEXT UNIQUE NOT NULL,
    name            TEXT,
    timezone        TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    currency        TEXT NOT NULL DEFAULT 'ARS',
    locale          TEXT NOT NULL DEFAULT 'es-AR',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 2. categories
-- =====================================================================
CREATE TABLE IF NOT EXISTS categories (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    emoji             TEXT,
    color             TEXT,
    parent_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    keywords          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    type              TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense','income')),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    is_system         BOOLEAN NOT NULL DEFAULT FALSE, -- seeded categories
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, normalized_name, type)
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_categories_trgm ON categories USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_categories_keywords ON categories USING GIN (keywords);
CREATE OR REPLACE TRIGGER categories_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 3. payment_methods
-- =====================================================================
CREATE TABLE IF NOT EXISTS payment_methods (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    type              TEXT NOT NULL CHECK (type IN
                          ('cash','credit_card','debit_card','transfer','digital_wallet','other')),
    last_4_digits     TEXT,
    is_default        BOOLEAN NOT NULL DEFAULT FALSE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_pm_user ON payment_methods(user_id) WHERE is_active;
CREATE OR REPLACE TRIGGER pm_updated_at BEFORE UPDATE ON payment_methods
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 4. messages (conversation log — used for debug + idempotency)
-- =====================================================================
CREATE TABLE IF NOT EXISTS messages (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
    direction                TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    whatsapp_message_id      TEXT UNIQUE,
    content                  TEXT,
    transcribed_from_audio   BOOLEAN NOT NULL DEFAULT FALSE,
    intent                   TEXT,  -- log_expense / query / chart / delete / help / unknown
    processed                BOOLEAN NOT NULL DEFAULT FALSE,
    error                    TEXT,
    raw_payload              JSONB,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

-- =====================================================================
-- 5. transactions (the central table)
-- =====================================================================
CREATE TABLE IF NOT EXISTS transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    payment_method_id   UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
    message_id          UUID REFERENCES messages(id) ON DELETE SET NULL,
    type                TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense','income')),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL DEFAULT 'ARS',
    description         TEXT,
    raw_message         TEXT,                       -- original WhatsApp text
    transaction_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    notes               TEXT,
    location            TEXT,
    confidence_score    NUMERIC(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
    -- Receipt image fields (used when transaction comes from a photo)
    receipt_image_base64 TEXT,                          -- raw base64 of the photo
    receipt_mimetype     TEXT,                          -- e.g. image/jpeg
    receipt_data         JSONB,                         -- structured OCR output (merchant, items, etc.)
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_user_cat ON transactions(user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_type_date ON transactions(user_id, type, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_review ON transactions(user_id) WHERE needs_review;
CREATE INDEX IF NOT EXISTS idx_tx_with_receipt ON transactions(user_id) WHERE receipt_data IS NOT NULL;
CREATE OR REPLACE TRIGGER tx_updated_at BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 6. budgets
-- =====================================================================
CREATE TABLE IF NOT EXISTS budgets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES categories(id) ON DELETE CASCADE, -- NULL = global
    name                TEXT,
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL DEFAULT 'ARS',
    period              TEXT NOT NULL CHECK (period IN ('weekly','monthly','yearly')),
    start_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date            DATE,
    alert_threshold     NUMERIC(3,2) NOT NULL DEFAULT 0.80
                            CHECK (alert_threshold BETWEEN 0 AND 1),
    last_alert_sent_at  TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id) WHERE is_active;
CREATE OR REPLACE TRIGGER budgets_updated_at BEFORE UPDATE ON budgets
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 7. recurring_transactions
-- =====================================================================
CREATE TABLE IF NOT EXISTS recurring_transactions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    payment_method_id   UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
    type                TEXT NOT NULL CHECK (type IN ('expense','income')),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL DEFAULT 'ARS',
    description         TEXT NOT NULL,
    frequency           TEXT NOT NULL CHECK (frequency IN
                            ('daily','weekly','monthly','yearly')),
    day_of_period       INT,                              -- e.g. day 5 of month
    next_occurrence     DATE NOT NULL,
    last_occurrence     DATE,
    end_date            DATE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recur_user ON recurring_transactions(user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_recur_next ON recurring_transactions(next_occurrence) WHERE is_active;
CREATE OR REPLACE TRIGGER recur_updated_at BEFORE UPDATE ON recurring_transactions
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 8. tags + 9. transaction_tags
-- =====================================================================
CREATE TABLE IF NOT EXISTS tags (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    color             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id    UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id            UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_txtags_tag ON transaction_tags(tag_id);

-- =====================================================================
-- 10. category_learning (improve matching over time)
-- =====================================================================
CREATE TABLE IF NOT EXISTS category_learning (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_text            TEXT NOT NULL,
    normalized_input      TEXT NOT NULL,
    matched_category_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
    final_category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    was_corrected         BOOLEAN NOT NULL DEFAULT FALSE,
    confidence_score      NUMERIC(3,2),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_learn_user ON category_learning(user_id);
CREATE INDEX IF NOT EXISTS idx_learn_input_trgm ON category_learning
    USING GIN (normalized_input gin_trgm_ops);

-- =====================================================================
-- View: monthly summary (used by query/chart intents and Metabase)
-- =====================================================================
CREATE OR REPLACE VIEW v_monthly_summary AS
SELECT
    t.user_id,
    DATE_TRUNC('month', t.transaction_date)::DATE AS month,
    t.type,
    t.category_id,
    c.name           AS category_name,
    c.emoji          AS category_emoji,
    t.currency,
    COUNT(*)         AS tx_count,
    SUM(t.amount)    AS total_amount,
    AVG(t.amount)    AS avg_amount,
    MIN(t.amount)    AS min_amount,
    MAX(t.amount)    AS max_amount
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
GROUP BY t.user_id, DATE_TRUNC('month', t.transaction_date),
         t.type, t.category_id, c.name, c.emoji, t.currency;

-- =====================================================================
-- View: budget status (consumption + remaining)
-- =====================================================================
CREATE OR REPLACE VIEW v_budget_status AS
SELECT
    b.id           AS budget_id,
    b.user_id,
    b.category_id,
    c.name         AS category_name,
    b.amount       AS budget_amount,
    b.currency,
    b.period,
    CASE b.period
        WHEN 'weekly'  THEN DATE_TRUNC('week',  CURRENT_DATE)
        WHEN 'monthly' THEN DATE_TRUNC('month', CURRENT_DATE)
        WHEN 'yearly'  THEN DATE_TRUNC('year',  CURRENT_DATE)
    END::DATE      AS period_start,
    COALESCE((
        SELECT SUM(t.amount)
        FROM transactions t
        WHERE t.user_id = b.user_id
          AND t.type = 'expense'
          AND (b.category_id IS NULL OR t.category_id = b.category_id)
          AND t.currency = b.currency
          AND t.transaction_date >= CASE b.period
                WHEN 'weekly'  THEN DATE_TRUNC('week',  CURRENT_DATE)
                WHEN 'monthly' THEN DATE_TRUNC('month', CURRENT_DATE)
                WHEN 'yearly'  THEN DATE_TRUNC('year',  CURRENT_DATE)
              END::DATE
    ), 0)          AS spent_amount,
    b.alert_threshold,
    b.is_active
FROM budgets b
LEFT JOIN categories c ON c.id = b.category_id
WHERE b.is_active;

-- =====================================================================
-- Function: smart category match for a given user + free-text input
-- Order: (1) exact normalized name, (2) keyword match, (3) trigram similarity
-- Returns the best match or NULL.
-- =====================================================================
CREATE OR REPLACE FUNCTION find_best_category(
    p_user_id UUID,
    p_input   TEXT,
    p_type    TEXT DEFAULT 'expense',
    p_min_similarity NUMERIC DEFAULT 0.35
)
RETURNS TABLE(category_id UUID, category_name TEXT, score NUMERIC, match_kind TEXT) AS $$
DECLARE
    v_norm TEXT := normalize_text(p_input);
BEGIN
    -- 1) exact normalized name
    RETURN QUERY
    SELECT c.id, c.name, 1.00::NUMERIC, 'exact'::TEXT
    FROM categories c
    WHERE c.user_id = p_user_id AND c.is_active AND c.type = p_type
      AND c.normalized_name = v_norm
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 2) keyword array contains any token from the input
    RETURN QUERY
    SELECT c.id, c.name, 0.90::NUMERIC, 'keyword'::TEXT
    FROM categories c
    WHERE c.user_id = p_user_id AND c.is_active AND c.type = p_type
      AND EXISTS (
        SELECT 1
        FROM unnest(c.keywords) AS k
        WHERE v_norm LIKE '%' || normalize_text(k) || '%'
      )
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- 3) trigram similarity on category name
    RETURN QUERY
    SELECT c.id, c.name,
           similarity(c.normalized_name, v_norm)::NUMERIC,
           'trigram'::TEXT
    FROM categories c
    WHERE c.user_id = p_user_id AND c.is_active AND c.type = p_type
      AND similarity(c.normalized_name, v_norm) >= p_min_similarity
    ORDER BY similarity(c.normalized_name, v_norm) DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- Seed: default category template (system categories — copied per new user)
-- We don't insert per-user here; the n8n workflow's onboarding step
-- copies these for each new user_id from this template.
-- =====================================================================
CREATE TABLE IF NOT EXISTS category_templates (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    emoji           TEXT,
    color           TEXT,
    keywords        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    type            TEXT NOT NULL DEFAULT 'expense'
);

INSERT INTO category_templates (name, emoji, color, keywords, type) VALUES
    ('Comida',         '🍽️', '#FF6B6B',
        ARRAY['comida','almuerzo','cena','desayuno','merienda','restaurant',
              'restaurante','delivery','pedidos','rappi','pedidosya','mcdonald',
              'burger','pizza','sushi','parrilla','choripan','milanesa','asado'],
        'expense'),
    ('Café',           '☕', '#A0522D',
        ARRAY['cafe','starbucks','havanna','barista','espresso','capuchino','latte'],
        'expense'),
    ('Supermercado',   '🛒', '#4CAF50',
        ARRAY['super','supermercado','mercado','coto','disco','jumbo','carrefour',
              'dia','vea','changomas','almacen','kiosco','verduleria','carniceria'],
        'expense'),
    ('Transporte',     '🚗', '#2196F3',
        ARRAY['uber','cabify','didi','taxi','sube','colectivo','tren','subte',
              'nafta','combustible','ypf','shell','axion','peaje','estacionamiento'],
        'expense'),
    ('Servicios',      '💡', '#FFC107',
        ARRAY['luz','gas','agua','internet','wifi','telefono','celular','cable',
              'edesur','edenor','metrogas','aysa','telecentro','fibertel','movistar',
              'claro','personal','expensas','abl','arba','rentas'],
        'expense'),
    ('Suscripciones',  '📺', '#9C27B0',
        ARRAY['netflix','spotify','disney','hbo','max','prime','youtube','apple',
              'icloud','dropbox','chatgpt','suscripcion','membership'],
        'expense'),
    ('Salud',          '🏥', '#E91E63',
        ARRAY['farmacia','medicamento','remedio','medico','consulta','clinica',
              'hospital','obra social','prepaga','osde','swiss','galeno','dentista',
              'oculista','laboratorio','analisis'],
        'expense'),
    ('Educación',      '📚', '#3F51B5',
        ARRAY['curso','libro','universidad','colegio','escuela','clase','clases',
              'profesor','udemy','coursera','platzi'],
        'expense'),
    ('Ocio',           '🎬', '#FF9800',
        ARRAY['cine','teatro','recital','concierto','salida','bar','boliche',
              'cumpleaños','fiesta','hobby','juego','steam','playstation'],
        'expense'),
    ('Ropa',           '👕', '#795548',
        ARRAY['ropa','remera','pantalon','zapatillas','zapatos','campera',
              'vestido','indumentaria','adidas','nike'],
        'expense'),
    ('Hogar',          '🏠', '#607D8B',
        ARRAY['hogar','muebles','easy','sodimac','hipertehuelche','ferreteria',
              'decoracion','limpieza','toallas','sabanas'],
        'expense'),
    ('Mascotas',       '🐾', '#8BC34A',
        ARRAY['mascota','perro','gato','veterinaria','alimento balanceado','pipeta'],
        'expense'),
    ('Viajes',         '✈️', '#00BCD4',
        ARRAY['viaje','vacaciones','hotel','airbnb','vuelo','pasaje','aerolineas',
              'turismo'],
        'expense'),
    ('Regalos',        '🎁', '#F06292',
        ARRAY['regalo','obsequio','navidad','cumple'],
        'expense'),
    ('Impuestos',      '🧾', '#455A64',
        ARRAY['impuesto','afip','monotributo','iibb','ganancias','bienes personales'],
        'expense'),
    ('Otros',          '📦', '#9E9E9E',
        ARRAY['otros','varios','misc'],
        'expense'),
    -- income side
    ('Sueldo',         '💼', '#4CAF50', ARRAY['sueldo','salario','haber'], 'income'),
    ('Freelance',      '💻', '#03A9F4', ARRAY['freelance','proyecto','cliente','factura'], 'income'),
    ('Inversiones',    '📈', '#009688', ARRAY['dividendo','interes','renta','plazo fijo'], 'income'),
    ('Otros ingresos', '💰', '#9E9E9E', ARRAY['regalo','reintegro','venta'], 'income');

-- =====================================================================
-- Function: bootstrap a new user (creates default categories + payment methods)
-- Called by n8n workflow when an unknown phone number sends a message.
-- =====================================================================
CREATE OR REPLACE FUNCTION bootstrap_user(
    p_phone TEXT,
    p_name  TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_user_id UUID;
BEGIN
    INSERT INTO users (phone_number, name)
    VALUES (p_phone, p_name)
    ON CONFLICT (phone_number) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
    RETURNING id INTO v_user_id;

    -- Seed categories from template (idempotent)
    INSERT INTO categories (user_id, name, normalized_name, emoji, color, keywords, type, is_system)
    SELECT v_user_id, ct.name, normalize_text(ct.name), ct.emoji, ct.color, ct.keywords, ct.type, TRUE
    FROM category_templates ct
    ON CONFLICT (user_id, normalized_name, type) DO NOTHING;

    -- Default payment methods
    INSERT INTO payment_methods (user_id, name, normalized_name, type, is_default)
    VALUES
        (v_user_id, 'Efectivo',     normalize_text('Efectivo'),     'cash',           TRUE),
        (v_user_id, 'Débito',       normalize_text('Débito'),       'debit_card',     FALSE),
        (v_user_id, 'Crédito',      normalize_text('Crédito'),      'credit_card',    FALSE),
        (v_user_id, 'Transferencia',normalize_text('Transferencia'),'transfer',       FALSE),
        (v_user_id, 'Mercado Pago', normalize_text('Mercado Pago'), 'digital_wallet', FALSE)
    ON CONFLICT (user_id, normalized_name) DO NOTHING;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Done.
-- =====================================================================


-- =====================================================================
-- Migration 001: Expense groups, onboarding, exclusion flags, conversation state
-- =====================================================================
-- =====================================================================
-- Migration 001: Expense groups (envoltorio genérico — viajes, eventos,
-- emergencias, etc.), onboarding, exclusion flags, conversation state.
-- Idempotent.
-- =====================================================================
-- ---------- 1. Expense groups (genérico) ----------
CREATE TABLE IF NOT EXISTS expense_groups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    normalized_name TEXT GENERATED ALWAYS AS (normalize_text(name)) STORED,
    kind            TEXT NOT NULL DEFAULT 'event',  -- 'trip', 'event', 'emergency', 'project', 'other'
    emoji           TEXT,
    starts_at       DATE,
    ends_at         DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    excluded_from_reports BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_groups_user_active ON expense_groups(user_id) WHERE is_active;

DO $$ BEGIN
    CREATE TRIGGER groups_updated_at BEFORE UPDATE ON expense_groups
        FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 2. Vincular transacciones a grupos ----------
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES expense_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tx_group ON transactions(group_id) WHERE group_id IS NOT NULL;

-- ---------- 3. Exclusión de reportes ----------
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS excluded_from_reports BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS excluded_from_reports BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- 4. Onboarding & user prefs ----------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarded BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS onboarding_step TEXT,
    ADD COLUMN IF NOT EXISTS preferred_currency TEXT NOT NULL DEFAULT 'ARS',
    ADD COLUMN IF NOT EXISTS daily_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS daily_summary_hour INT NOT NULL DEFAULT 22 CHECK (daily_summary_hour BETWEEN 0 AND 23),
    ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------- 5. Conversation state ----------
CREATE TABLE IF NOT EXISTS conversation_state (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state       TEXT NOT NULL,
    context     JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    CREATE TRIGGER convstate_updated_at BEFORE UPDATE ON conversation_state
        FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 6. Reply templates (variedad de mensajes) ----------
CREATE TABLE IF NOT EXISTS reply_templates (
    id          SERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    template    TEXT NOT NULL,
    weight      INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_replytmpl_kind ON reply_templates(kind);

INSERT INTO reply_templates (kind, template) VALUES
    ('expense_logged', '✅ Anotado: ${amount} en {category}{description}\n📅 {date}'),
    ('expense_logged', '👌 Listo, ${amount} en {category}{description} · {date}'),
    ('expense_logged', '✍️ Va: ${amount} • {category}{description} • {date}'),
    ('expense_logged', '📝 Quedó: ${amount} en {category}{description}, {date}'),
    ('expense_logged', '✅ Registré ${amount} de {category}{description} ({date})'),
    ('expense_logged', 'Listo 👌 ${amount} en {category}{description}, {date}'),
    ('expense_logged_group', '✅ Anotado en {group}: ${amount} • {category}{description} · {date}'),
    ('expense_logged_group', '🧳 Sumé ${amount} a {group}: {category}{description} ({date})'),
    ('income_logged', '💰 Buenísimo, entró ${amount} de {category}{description}\n📅 {date}'),
    ('income_logged', '🤑 Ingreso anotado: ${amount} en {category}{description} · {date}'),
    ('income_logged', '💸 Plata adentro: ${amount} • {category} · {date}'),
    ('deleted', '🗑️ Borré el último: ${amount}{description} del {date}.'),
    ('deleted', '👍 Listo, eliminé ${amount}{description} ({date}).'),
    ('deleted', '✋ Borrado: ${amount}{description}, {date}.'),
    ('no_data', '📭 No tengo registros para {period} todavía.'),
    ('no_data', '🫥 Nada cargado en {period}. Mandame un gasto y arrancamos.'),
    ('error', '😅 Se me trabó algo, mandámelo de vuelta porfa.'),
    ('error', '🫠 Tuve un problemita, ¿lo intentamos otra vez?'),
    ('error', 'Uh, se me cruzaron los cables. Repetímelo en un toque 🙏'),
    ('greeting', '👋 ¡Hola{name}! Listo para anotar gastos.'),
    ('greeting', 'Buenas{name} 🙌 mandame lo que gastaste y lo registro.'),
    ('confirm_otros', '🤔 No me quedó claro a qué categoría va. ¿Querés que lo guarde en *Otros* o preferís especificar (ej: comida, transporte, servicios)?'),
    ('confirm_otros', '👀 Esto lo voy a guardar en *Otros*. Si querés afinar la categoría, decímela; si está bien así, mandame "ok".'),
    ('clarify_amount', '🧐 No agarré bien el monto. ¿Cuánto fue?'),
    ('clarify_amount', '¿Me pasás el monto? No lo pesqué.'),
    ('over_budget', '⚠️ Te pasaste del presupuesto de *{category}* este mes: ${total} de ${budget}.'),
    ('near_budget', '🟡 Vas por ${total} en *{category}* este mes (presupuesto ${budget}).'),
    ('daily_summary_zero', '🧘 Hoy no registraste gastos. Buen día para la billetera.'),
    ('daily_summary_zero', '🎉 Día sin gastos registrados.')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pick_reply(p_kind TEXT)
RETURNS TEXT AS $$
DECLARE result TEXT;
BEGIN
    SELECT template INTO result FROM reply_templates WHERE kind = p_kind ORDER BY random() LIMIT 1;
    RETURN COALESCE(result, '');
END;
$$ LANGUAGE plpgsql;

-- ---------- 7. format_reply: substituye placeholders + da formato lindo ----------
CREATE OR REPLACE FUNCTION format_reply(
    p_kind TEXT,
    p_amount NUMERIC DEFAULT NULL,
    p_category TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_period TEXT DEFAULT NULL,
    p_group TEXT DEFAULT NULL,
    p_total NUMERIC DEFAULT NULL,
    p_budget NUMERIC DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
    tpl TEXT;
    desc_part TEXT;
    name_part TEXT;
    date_part TEXT;
BEGIN
    tpl := pick_reply(p_kind);
    desc_part := CASE WHEN COALESCE(p_description, '') = '' THEN '' ELSE ' — ' || p_description END;
    name_part := CASE WHEN COALESCE(p_name, '') = '' THEN '' ELSE ' ' || p_name END;
    date_part := CASE
        WHEN p_date IS NULL THEN ''
        WHEN p_date = CURRENT_DATE THEN 'hoy'
        WHEN p_date = CURRENT_DATE - 1 THEN 'ayer'
        ELSE (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[EXTRACT(DOW FROM p_date)::INT + 1]
             || ' ' || TO_CHAR(p_date, 'FMDD') || ' de '
             || (ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[EXTRACT(MONTH FROM p_date)::INT]
    END;
    -- Format numbers in es-AR style: 2.000,00 (dot thousands, comma decimal)
    tpl := REPLACE(tpl, '{amount}',      COALESCE(TRANSLATE(TO_CHAR(p_amount, 'FM999G999G990D00'), ',.', '.,'), ''));
    tpl := REPLACE(tpl, '{category}',    COALESCE(p_category, ''));
    tpl := REPLACE(tpl, '{description}', desc_part);
    tpl := REPLACE(tpl, '{date}',        date_part);
    tpl := REPLACE(tpl, '{name}',        name_part);
    tpl := REPLACE(tpl, '{period}',      COALESCE(p_period, ''));
    tpl := REPLACE(tpl, '{group}',       COALESCE(p_group, ''));
    tpl := REPLACE(tpl, '{total}',       COALESCE(TRANSLATE(TO_CHAR(p_total, 'FM999G999G990D00'), ',.', '.,'), ''));
    tpl := REPLACE(tpl, '{budget}',      COALESCE(TRANSLATE(TO_CHAR(p_budget, 'FM999G999G990D00'), ',.', '.,'), ''));
    RETURN tpl;
END;
$$ LANGUAGE plpgsql;

-- ---------- 8. View: transactions reportables ----------
CREATE OR REPLACE VIEW v_reportable_transactions AS
SELECT t.*
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN expense_groups g ON g.id = t.group_id
WHERE t.excluded_from_reports = FALSE
  AND COALESCE(c.excluded_from_reports, FALSE) = FALSE
  AND COALESCE(g.excluded_from_reports, FALSE) = FALSE;

-- ---------- 9. Helper: get_user_state (para onboarding) ----------
CREATE OR REPLACE FUNCTION get_user_state(p_user_id UUID)
RETURNS TABLE(onboarded BOOLEAN, onboarding_step TEXT, conv_state TEXT, conv_context JSONB) AS $$
BEGIN
    RETURN QUERY
    SELECT u.onboarded,
           u.onboarding_step,
           cs.state,
           cs.context
    FROM users u
    LEFT JOIN conversation_state cs ON cs.user_id = u.id AND cs.expires_at > NOW()
    WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- 10. Helper: set/clear conversation state ----------
CREATE OR REPLACE FUNCTION set_conv_state(p_user_id UUID, p_state TEXT, p_context JSONB DEFAULT '{}'::jsonb, p_ttl_seconds INT DEFAULT 300)
RETURNS VOID AS $$
BEGIN
    INSERT INTO conversation_state (user_id, state, context, expires_at)
    VALUES (p_user_id, p_state, p_context, NOW() + (p_ttl_seconds || ' seconds')::INTERVAL)
    ON CONFLICT (user_id) DO UPDATE
    SET state = EXCLUDED.state,
        context = EXCLUDED.context,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION clear_conv_state(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    DELETE FROM conversation_state WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- 11. Helper: find/upsert expense group by name ----------
CREATE OR REPLACE FUNCTION upsert_group(p_user_id UUID, p_name TEXT, p_kind TEXT DEFAULT 'event')
RETURNS UUID AS $$
DECLARE g_id UUID;
BEGIN
    INSERT INTO expense_groups (user_id, name, kind)
    VALUES (p_user_id, p_name, p_kind)
    ON CONFLICT (user_id, normalized_name) DO UPDATE SET is_active = TRUE
    RETURNING id INTO g_id;
    RETURN g_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- 12. Daily summary query (helper) ----------
CREATE OR REPLACE FUNCTION daily_summary(p_user_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE(total NUMERIC, n INT, top_category TEXT, top_amount NUMERIC) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT t.amount, c.name AS cat
        FROM v_reportable_transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = p_user_id
          AND t.type = 'expense'
          AND t.transaction_date = p_date
    ),
    top_cat AS (
        SELECT cat, SUM(amount) AS s FROM base GROUP BY cat ORDER BY s DESC LIMIT 1
    )
    SELECT COALESCE(SUM(b.amount), 0)::NUMERIC,
           COUNT(*)::INT,
           (SELECT cat FROM top_cat),
           (SELECT s FROM top_cat)
    FROM base b;
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- Migration 002: Budget alerts, recurring helpers, group detection
-- =====================================================================
-- =====================================================================
-- Migration 002: Budget alerts, recurring helpers, group detection,
-- onboarding helpers, PDF report metadata.
-- Idempotent.
-- =====================================================================
-- ---------- 1. Budget status check (después de un insert) ----------
CREATE OR REPLACE FUNCTION check_budget_status(p_user_id UUID, p_category_id UUID)
RETURNS TABLE(should_alert BOOLEAN, level TEXT, total NUMERIC, budget_amount NUMERIC, category_name TEXT) AS $$
DECLARE
    v_budget NUMERIC;
    v_period TEXT;
    v_total NUMERIC;
    v_pct NUMERIC;
    v_cat_name TEXT;
    v_period_sql TEXT;
BEGIN
    SELECT b.amount, b.period, c.name
    INTO v_budget, v_period, v_cat_name
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = p_user_id AND b.category_id = p_category_id AND b.is_active
    LIMIT 1;

    IF v_budget IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, 0::NUMERIC, 0::NUMERIC, ''::TEXT;
        RETURN;
    END IF;

    -- Calculate spent in this period
    IF v_period = 'weekly' THEN
        SELECT COALESCE(SUM(amount),0) INTO v_total
        FROM v_reportable_transactions
        WHERE user_id = p_user_id AND category_id = p_category_id AND type='expense'
          AND transaction_date >= DATE_TRUNC('week', CURRENT_DATE);
    ELSIF v_period = 'yearly' THEN
        SELECT COALESCE(SUM(amount),0) INTO v_total
        FROM v_reportable_transactions
        WHERE user_id = p_user_id AND category_id = p_category_id AND type='expense'
          AND transaction_date >= DATE_TRUNC('year', CURRENT_DATE);
    ELSE
        SELECT COALESCE(SUM(amount),0) INTO v_total
        FROM v_reportable_transactions
        WHERE user_id = p_user_id AND category_id = p_category_id AND type='expense'
          AND transaction_date >= DATE_TRUNC('month', CURRENT_DATE);
    END IF;

    v_pct := (v_total / NULLIF(v_budget, 0)) * 100;

    IF v_pct >= 100 THEN
        RETURN QUERY SELECT TRUE, 'over_budget'::TEXT, v_total, v_budget, v_cat_name;
    ELSIF v_pct >= 80 THEN
        RETURN QUERY SELECT TRUE, 'near_budget'::TEXT, v_total, v_budget, v_cat_name;
    ELSE
        RETURN QUERY SELECT FALSE, NULL::TEXT, v_total, v_budget, v_cat_name;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. Recurring transactions: process due ones ----------
-- (cron en n8n llama a esto cada 6h)
-- DROP necesario: cambiamos los nombres de los OUT params (user_id -> out_user_id, etc.).
-- CREATE OR REPLACE no permite cambiar el row type definido por los OUT.
DROP FUNCTION IF EXISTS process_due_recurring();
CREATE OR REPLACE FUNCTION process_due_recurring()
RETURNS TABLE(out_user_id UUID, out_phone TEXT, out_transaction_id UUID, out_amount NUMERIC, out_description TEXT, out_category_name TEXT) AS $$
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT r.id AS rec_id, r.user_id, r.amount, r.description, r.category_id, r.payment_method_id,
               r.next_occurrence, r.frequency
        FROM recurring_transactions r
        WHERE r.is_active AND r.next_occurrence <= CURRENT_DATE
        FOR UPDATE OF r SKIP LOCKED
    ),
    inserted AS (
        INSERT INTO transactions (user_id, category_id, payment_method_id, type, amount, currency,
                                   description, raw_message, transaction_date, confidence_score, metadata)
        SELECT d.user_id, d.category_id, d.payment_method_id, 'expense', d.amount, 'ARS',
               d.description, '[recurring]', d.next_occurrence, 1.0,
               jsonb_build_object('source', 'recurring', 'recurring_id', d.rec_id)
        FROM due d
        RETURNING transactions.id, transactions.user_id, transactions.amount, transactions.description, transactions.category_id, transactions.transaction_date
    ),
    bumped AS (
        UPDATE recurring_transactions r
        SET next_occurrence = CASE r.frequency
            WHEN 'daily' THEN r.next_occurrence + INTERVAL '1 day'
            WHEN 'weekly' THEN r.next_occurrence + INTERVAL '1 week'
            WHEN 'biweekly' THEN r.next_occurrence + INTERVAL '2 weeks'
            WHEN 'monthly' THEN r.next_occurrence + INTERVAL '1 month'
            WHEN 'yearly' THEN r.next_occurrence + INTERVAL '1 year'
            ELSE r.next_occurrence + INTERVAL '1 month'
        END
        FROM due d WHERE r.id = d.rec_id
        RETURNING r.id
    )
    SELECT i.user_id, u.phone_number, i.id, i.amount, i.description, c.name
    FROM inserted i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN categories c ON c.id = i.category_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- 3. Generate PDF-ready report data ----------
CREATE OR REPLACE FUNCTION generate_report_data(p_user_id UUID, p_start DATE, p_end DATE)
RETURNS JSONB AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'period', jsonb_build_object('start', p_start, 'end', p_end),
        'totals', (
            SELECT jsonb_build_object(
                'expense', COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0),
                'income',  COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0),
                'count',   COUNT(*)
            )
            FROM v_reportable_transactions
            WHERE user_id = p_user_id AND transaction_date BETWEEN p_start AND p_end
        ),
        'by_category', (
            SELECT COALESCE(jsonb_agg(t ORDER BY t.total DESC), '[]'::jsonb) FROM (
                SELECT c.name AS category, c.emoji, SUM(amount)::NUMERIC AS total, COUNT(*) AS n
                FROM v_reportable_transactions vt
                LEFT JOIN categories c ON c.id = vt.category_id
                WHERE vt.user_id = p_user_id AND vt.type='expense' AND vt.transaction_date BETWEEN p_start AND p_end
                GROUP BY c.name, c.emoji
            ) t
        ),
        'by_day', (
            SELECT COALESCE(jsonb_agg(t ORDER BY t.day), '[]'::jsonb) FROM (
                SELECT transaction_date::text AS day, SUM(amount)::NUMERIC AS total
                FROM v_reportable_transactions
                WHERE user_id = p_user_id AND type='expense' AND transaction_date BETWEEN p_start AND p_end
                GROUP BY transaction_date
            ) t
        ),
        'transactions', (
            SELECT COALESCE(jsonb_agg(t ORDER BY t.date DESC), '[]'::jsonb) FROM (
                SELECT vt.transaction_date::text AS date, vt.amount, vt.description, vt.type,
                       c.name AS category, c.emoji, p.name AS payment_method, g.name AS group_name
                FROM v_reportable_transactions vt
                LEFT JOIN categories c ON c.id = vt.category_id
                LEFT JOIN payment_methods p ON p.id = vt.payment_method_id
                LEFT JOIN expense_groups g ON g.id = vt.group_id
                WHERE vt.user_id = p_user_id AND vt.transaction_date BETWEEN p_start AND p_end
                ORDER BY vt.transaction_date DESC, vt.created_at DESC
            ) t
        )
    ) INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ---------- 4. List all groups (for menu / commands) ----------
CREATE OR REPLACE FUNCTION list_groups(p_user_id UUID, p_active_only BOOLEAN DEFAULT TRUE)
RETURNS TABLE(id UUID, name TEXT, kind TEXT, emoji TEXT, total NUMERIC, n INT, excluded BOOLEAN) AS $$
BEGIN
    RETURN QUERY
    SELECT g.id, g.name, g.kind, g.emoji,
           COALESCE(SUM(t.amount), 0)::NUMERIC,
           COUNT(t.id)::INT,
           g.excluded_from_reports
    FROM expense_groups g
    LEFT JOIN transactions t ON t.group_id = g.id AND t.type='expense'
    WHERE g.user_id = p_user_id AND (NOT p_active_only OR g.is_active)
    GROUP BY g.id, g.name, g.kind, g.emoji, g.excluded_from_reports
    ORDER BY g.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ---------- 5. Toggle category exclusion ----------
CREATE OR REPLACE FUNCTION toggle_category_exclusion(p_user_id UUID, p_category_hint TEXT)
RETURNS TABLE(name TEXT, excluded BOOLEAN) AS $$
DECLARE v_cat_id UUID; v_excluded BOOLEAN; v_name TEXT;
BEGIN
    SELECT c.id, c.name INTO v_cat_id, v_name
    FROM categories c
    WHERE c.user_id = p_user_id
      AND (c.normalized_name % normalize_text(p_category_hint) OR c.normalized_name = normalize_text(p_category_hint))
    ORDER BY similarity(c.normalized_name, normalize_text(p_category_hint)) DESC
    LIMIT 1;

    IF v_cat_id IS NULL THEN
        RETURN QUERY SELECT NULL::TEXT, NULL::BOOLEAN;
        RETURN;
    END IF;

    UPDATE categories SET excluded_from_reports = NOT excluded_from_reports
    WHERE id = v_cat_id RETURNING excluded_from_reports INTO v_excluded;

    RETURN QUERY SELECT v_name, v_excluded;
END;
$$ LANGUAGE plpgsql;

-- ---------- 6. Set/update budget by category name ----------
CREATE OR REPLACE FUNCTION set_budget(p_user_id UUID, p_category_hint TEXT, p_amount NUMERIC, p_period TEXT DEFAULT 'monthly')
RETURNS TABLE(category_name TEXT, amount NUMERIC, period TEXT) AS $$
DECLARE v_cat_id UUID; v_cat_name TEXT;
BEGIN
    SELECT c.id, c.name INTO v_cat_id, v_cat_name
    FROM categories c WHERE c.user_id = p_user_id AND c.normalized_name = normalize_text(p_category_hint)
    LIMIT 1;

    IF v_cat_id IS NULL THEN
        SELECT c.id, c.name INTO v_cat_id, v_cat_name
        FROM categories c WHERE c.user_id = p_user_id AND c.normalized_name % normalize_text(p_category_hint)
        ORDER BY similarity(c.normalized_name, normalize_text(p_category_hint)) DESC LIMIT 1;
    END IF;

    IF v_cat_id IS NULL THEN
        RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC, NULL::TEXT;
        RETURN;
    END IF;

    -- Try to update existing active budget for same (user, category, period)
    UPDATE budgets SET amount = p_amount, is_active = TRUE, updated_at = NOW()
    WHERE budgets.user_id = p_user_id
      AND budgets.category_id = v_cat_id
      AND budgets.period = p_period
      AND budgets.is_active = TRUE;

    -- If nothing was updated, insert new
    IF NOT FOUND THEN
        INSERT INTO budgets (user_id, category_id, amount, period, is_active)
        VALUES (p_user_id, v_cat_id, p_amount, p_period, TRUE);
    END IF;

    RETURN QUERY SELECT v_cat_name, p_amount, p_period;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Migration 003: transaction_at timestamp + duplicate check
-- =====================================================================

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS transaction_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tx_dup_check ON transactions(user_id, amount, transaction_date, created_at);

CREATE OR REPLACE FUNCTION check_duplicate_tx(
    p_user_id UUID,
    p_amount NUMERIC,
    p_date DATE,
    p_window_minutes INT DEFAULT 60
)
RETURNS TABLE(id UUID, amount NUMERIC, description TEXT, transaction_date DATE, created_at TIMESTAMPTZ) AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.amount, t.description, t.transaction_date, t.created_at
    FROM transactions t
    WHERE t.user_id = p_user_id
      AND t.amount = p_amount
      AND t.transaction_date = p_date
      AND t.created_at > NOW() - (p_window_minutes || ' minutes')::INTERVAL
    ORDER BY t.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Migration 004: flexible transaction matcher (find/edit/delete by hints)
-- =====================================================================
-- Returns up to p_limit transactions matching any combination of hints.
-- If all hints are NULL, returns the most recent transactions.
CREATE OR REPLACE FUNCTION find_matching_tx(
    p_user_id UUID,
    p_description_hint TEXT DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_amount NUMERIC DEFAULT NULL,
    p_category_hint TEXT DEFAULT NULL,
    p_limit INT DEFAULT 5
)
RETURNS TABLE(
    id UUID,
    amount NUMERIC,
    description TEXT,
    transaction_date DATE,
    category_id UUID,
    category_name TEXT,
    category_emoji TEXT,
    type TEXT,
    score REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.amount,
        t.description,
        t.transaction_date,
        t.category_id,
        c.name AS category_name,
        c.emoji AS category_emoji,
        t.type,
        (
            CASE WHEN p_description_hint IS NULL OR p_description_hint = '' THEN 0
                 ELSE GREATEST(
                     similarity(normalize_text(COALESCE(t.description,'')), normalize_text(p_description_hint)),
                     similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_description_hint))
                 ) END
          + CASE WHEN p_date IS NOT NULL AND t.transaction_date = p_date THEN 1 ELSE 0 END
          + CASE WHEN p_amount IS NOT NULL AND t.amount = p_amount THEN 1 ELSE 0 END
          + CASE WHEN p_category_hint IS NULL OR p_category_hint = '' THEN 0
                 ELSE similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_category_hint)) END
        )::REAL AS score
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = p_user_id
      AND (p_description_hint IS NULL OR p_description_hint = ''
           OR normalize_text(COALESCE(t.description,'')) % normalize_text(p_description_hint)
           OR normalize_text(COALESCE(c.name,'')) % normalize_text(p_description_hint))
      AND (p_date IS NULL OR t.transaction_date = p_date)
      AND (p_amount IS NULL OR t.amount = p_amount)
      AND (p_category_hint IS NULL OR p_category_hint = ''
           OR normalize_text(COALESCE(c.name,'')) % normalize_text(p_category_hint))
    ORDER BY score DESC, t.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Edit a transaction by id (returns updated row).
-- Categoria: aceptamos UUID directo o hint por nombre (resuelto via find_best_category o
-- resolve_or_create_category cuando p_create_category_if_missing=TRUE). Si llegan ambos,
-- el UUID gana.
DROP FUNCTION IF EXISTS update_tx(UUID, UUID, DATE, NUMERIC, TEXT, UUID);
CREATE OR REPLACE FUNCTION update_tx(
    p_user_id UUID,
    p_tx_id UUID,
    p_new_date DATE DEFAULT NULL,
    p_new_amount NUMERIC DEFAULT NULL,
    p_new_description TEXT DEFAULT NULL,
    p_new_category_id UUID DEFAULT NULL,
    p_new_category_hint TEXT DEFAULT NULL,
    p_create_category_if_missing BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(id UUID, amount NUMERIC, description TEXT, transaction_date DATE, category_name TEXT) AS $$
DECLARE
    v_resolved_cat_id UUID := p_new_category_id;
    v_tx_type TEXT;
BEGIN
    -- Resolver categoria por nombre si no vino UUID
    IF v_resolved_cat_id IS NULL AND COALESCE(p_new_category_hint, '') <> '' THEN
        SELECT t.type INTO v_tx_type
        FROM transactions t
        WHERE t.id = p_tx_id AND t.user_id = p_user_id;

        IF p_create_category_if_missing THEN
            SELECT category_id INTO v_resolved_cat_id
            FROM resolve_or_create_category(p_user_id, p_new_category_hint, COALESCE(v_tx_type, 'expense'));
        ELSE
            SELECT category_id INTO v_resolved_cat_id
            FROM find_best_category(p_user_id, p_new_category_hint, COALESCE(v_tx_type, 'expense'));
        END IF;
    END IF;

    RETURN QUERY
    UPDATE transactions t
    SET transaction_date = COALESCE(p_new_date, t.transaction_date),
        amount = COALESCE(p_new_amount, t.amount),
        description = COALESCE(NULLIF(p_new_description, ''), t.description),
        category_id = COALESCE(v_resolved_cat_id, t.category_id),
        updated_at = NOW()
    WHERE t.id = p_tx_id AND t.user_id = p_user_id
    RETURNING t.id, t.amount, t.description, t.transaction_date,
              (SELECT c.name FROM categories c WHERE c.id = t.category_id);
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- AGENT V2: tools para el clasificador conversacional con tool-calling
-- =====================================================================
-- Estas funciones reemplazan los handlers rígidos del switch por capacidades
-- que el LLM puede combinar libremente. Filosofía:
--   - Filtros determinísticos (monto, fecha, ids) son AND duros.
--   - Filtros fuzzy (descripción, categoría libre) solo afectan ranking.
--   - Ninguna función borra/edita sin recibir UUIDs explícitos.
--   - Todas devuelven datos estructurados listos para serializar a JSON.

-- ---------- A1. find_matching_tx_v2: matcher robusto con scoring ----------
-- Devuelve hasta p_limit transacciones, ordenadas por score.
-- Los hints fuzzy (description/category) NO excluyen filas; solo rankean,
-- salvo que sean los únicos filtros dados (entonces se aplica trigram %).
-- Si vienen filtros determinísticos (amount/date/range) son AND duros.
CREATE OR REPLACE FUNCTION find_matching_tx_v2(
    p_user_id UUID,
    p_description_hint TEXT DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL,
    p_amount NUMERIC DEFAULT NULL,
    p_amount_min NUMERIC DEFAULT NULL,
    p_amount_max NUMERIC DEFAULT NULL,
    p_category_hint TEXT DEFAULT NULL,
    p_type TEXT DEFAULT NULL,
    p_group_hint TEXT DEFAULT NULL,
    p_limit INT DEFAULT 20
)
RETURNS TABLE(
    id UUID,
    amount NUMERIC,
    description TEXT,
    transaction_date DATE,
    category_id UUID,
    category_name TEXT,
    category_emoji TEXT,
    type TEXT,
    group_name TEXT,
    score REAL,
    match_reasons JSONB
) AS $$
DECLARE
    v_has_deterministic BOOLEAN;
    v_has_fuzzy BOOLEAN;
BEGIN
    v_has_deterministic := (p_date IS NOT NULL OR p_date_from IS NOT NULL OR p_date_to IS NOT NULL
                            OR p_amount IS NOT NULL OR p_amount_min IS NOT NULL OR p_amount_max IS NOT NULL
                            OR p_type IS NOT NULL);
    v_has_fuzzy := (COALESCE(p_description_hint,'') <> '' OR COALESCE(p_category_hint,'') <> ''
                    OR COALESCE(p_group_hint,'') <> '');

    RETURN QUERY
    SELECT
        t.id,
        t.amount,
        t.description,
        t.transaction_date,
        t.category_id,
        c.name AS category_name,
        c.emoji AS category_emoji,
        t.type,
        g.name AS group_name,
        (
            CASE WHEN COALESCE(p_description_hint,'') = '' THEN 0
                 ELSE GREATEST(
                    similarity(normalize_text(COALESCE(t.description,'')), normalize_text(p_description_hint)),
                    similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_description_hint))
                 ) * 0.5 END
          + CASE WHEN COALESCE(p_category_hint,'') = '' THEN 0
                 ELSE similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_category_hint)) * 0.4 END
          + CASE WHEN COALESCE(p_group_hint,'') = '' THEN 0
                 ELSE similarity(normalize_text(COALESCE(g.name,'')), normalize_text(p_group_hint)) * 0.3 END
          + CASE WHEN p_amount IS NOT NULL AND t.amount = p_amount THEN 0.2 ELSE 0 END
          + CASE WHEN p_date IS NOT NULL AND t.transaction_date = p_date THEN 0.2 ELSE 0 END
        )::REAL AS score,
        jsonb_build_object(
            'exact_amount', (p_amount IS NOT NULL AND t.amount = p_amount),
            'exact_date', (p_date IS NOT NULL AND t.transaction_date = p_date),
            'in_date_range', (p_date_from IS NOT NULL OR p_date_to IS NOT NULL),
            'in_amount_range', (p_amount_min IS NOT NULL OR p_amount_max IS NOT NULL),
            'desc_similarity', CASE WHEN COALESCE(p_description_hint,'') = '' THEN NULL
                                    ELSE GREATEST(
                                        similarity(normalize_text(COALESCE(t.description,'')), normalize_text(p_description_hint)),
                                        similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_description_hint))
                                    ) END,
            'cat_similarity', CASE WHEN COALESCE(p_category_hint,'') = '' THEN NULL
                                   ELSE similarity(normalize_text(COALESCE(c.name,'')), normalize_text(p_category_hint)) END
        ) AS match_reasons
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN expense_groups g ON g.id = t.group_id
    WHERE t.user_id = p_user_id
      -- Hard filters (AND, determinísticos)
      AND (p_date IS NULL OR t.transaction_date = p_date)
      AND (p_date_from IS NULL OR t.transaction_date >= p_date_from)
      AND (p_date_to IS NULL OR t.transaction_date <= p_date_to)
      AND (p_amount IS NULL OR t.amount = p_amount)
      AND (p_amount_min IS NULL OR t.amount >= p_amount_min)
      AND (p_amount_max IS NULL OR t.amount <= p_amount_max)
      AND (p_type IS NULL OR t.type = p_type)
      -- Fuzzy filters: si NO hay determinístico, exigimos al menos un trigram match.
      -- Si hay determinístico, los fuzzy son solo ranking.
      AND (v_has_deterministic
           OR NOT v_has_fuzzy
           OR (COALESCE(p_description_hint,'') <> ''
               AND (normalize_text(COALESCE(t.description,'')) ILIKE '%' || normalize_text(p_description_hint) || '%'
                    OR normalize_text(COALESCE(c.name,'')) ILIKE '%' || normalize_text(p_description_hint) || '%'
                    OR normalize_text(COALESCE(t.description,'')) % normalize_text(p_description_hint)
                    OR normalize_text(COALESCE(c.name,'')) % normalize_text(p_description_hint)))
           OR (COALESCE(p_category_hint,'') <> ''
               AND (normalize_text(COALESCE(c.name,'')) ILIKE '%' || normalize_text(p_category_hint) || '%'
                    OR normalize_text(COALESCE(c.name,'')) % normalize_text(p_category_hint)))
           OR (COALESCE(p_group_hint,'') <> ''
               AND (normalize_text(COALESCE(g.name,'')) ILIKE '%' || normalize_text(p_group_hint) || '%'
                    OR normalize_text(COALESCE(g.name,'')) % normalize_text(p_group_hint)))
          )
    ORDER BY score DESC, t.transaction_date DESC, t.created_at DESC
    LIMIT GREATEST(p_limit, 1);
END;
$$ LANGUAGE plpgsql;

-- ---------- A2. query_tx_dynamic: query flexible con paginación ----------
-- Tool principal de lectura para el agente. Acepta cualquier combinación de
-- filtros vía JSONB y devuelve transacciones + total_count para paginar.
-- Filtros soportados:
--   period: today|yesterday|this_week|this_month|last_month|this_year|all|custom
--   start_date, end_date: ISO (solo si period='custom')
--   category, description_contains, group_name, payment_method
--   exact_amount, min_amount, max_amount
--   type: expense|income|both
--   sort: date_desc|date_asc|amount_desc|amount_asc
--   limit (1..50), offset
CREATE OR REPLACE FUNCTION query_tx_dynamic(
    p_user_id UUID,
    p_filters JSONB DEFAULT '{}'::jsonb,
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS TABLE(
    id UUID,
    transaction_date DATE,
    amount NUMERIC,
    description TEXT,
    category_name TEXT,
    category_emoji TEXT,
    type TEXT,
    payment_method_name TEXT,
    group_name TEXT,
    total_count BIGINT
) AS $$
DECLARE
    v_period TEXT := COALESCE(p_filters->>'period', 'all');
    v_start DATE;
    v_end DATE;
    v_type TEXT := NULLIF(p_filters->>'type', '');
    v_category TEXT := NULLIF(p_filters->>'category', '');
    v_desc TEXT := NULLIF(p_filters->>'description_contains', '');
    v_group TEXT := NULLIF(p_filters->>'group_name', '');
    v_pm TEXT := NULLIF(p_filters->>'payment_method', '');
    v_exact_amt NUMERIC := NULLIF(p_filters->>'exact_amount', '')::NUMERIC;
    v_min_amt NUMERIC := NULLIF(p_filters->>'min_amount', '')::NUMERIC;
    v_max_amt NUMERIC := NULLIF(p_filters->>'max_amount', '')::NUMERIC;
    v_sort TEXT := COALESCE(p_filters->>'sort', 'date_desc');
    v_lim INT := LEAST(GREATEST(p_limit, 1), 50);
BEGIN
    -- Resolver período → rango de fechas
    CASE v_period
        WHEN 'today'      THEN v_start := CURRENT_DATE;                     v_end := CURRENT_DATE;
        WHEN 'yesterday'  THEN v_start := CURRENT_DATE - 1;                 v_end := CURRENT_DATE - 1;
        WHEN 'this_week'  THEN v_start := DATE_TRUNC('week', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'this_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'last_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE;
                                v_end := (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 day')::DATE;
        WHEN 'this_year'  THEN v_start := DATE_TRUNC('year', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'custom'     THEN v_start := NULLIF(p_filters->>'start_date','')::DATE;
                                v_end   := NULLIF(p_filters->>'end_date','')::DATE;
        ELSE                   v_start := NULL;  v_end := NULL;  -- 'all'
    END CASE;

    RETURN QUERY
    WITH base AS (
        SELECT
            t.id, t.transaction_date, t.amount, t.description,
            c.name AS category_name, c.emoji AS category_emoji, t.type,
            pm.name AS payment_method_name,
            g.name AS group_name,
            t.created_at
        FROM v_reportable_transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
        LEFT JOIN expense_groups g ON g.id = t.group_id
        WHERE t.user_id = p_user_id
          AND (v_start IS NULL OR t.transaction_date >= v_start)
          AND (v_end   IS NULL OR t.transaction_date <= v_end)
          AND (v_type  IS NULL OR v_type = 'both' OR t.type = v_type)
          AND (v_category IS NULL OR normalize_text(COALESCE(c.name,'')) % normalize_text(v_category))
          AND (v_desc IS NULL OR normalize_text(COALESCE(t.description,'')) ILIKE '%' || normalize_text(v_desc) || '%'
               OR normalize_text(COALESCE(t.description,'')) % normalize_text(v_desc))
          AND (v_group IS NULL OR normalize_text(COALESCE(g.name,'')) % normalize_text(v_group))
          AND (v_pm IS NULL OR normalize_text(COALESCE(pm.name,'')) % normalize_text(v_pm))
          AND (v_exact_amt IS NULL OR t.amount = v_exact_amt)
          AND (v_min_amt IS NULL OR t.amount >= v_min_amt)
          AND (v_max_amt IS NULL OR t.amount <= v_max_amt)
    ),
    counted AS (SELECT COUNT(*)::BIGINT AS n FROM base)
    SELECT b.id, b.transaction_date, b.amount, b.description, b.category_name, b.category_emoji,
           b.type, b.payment_method_name, b.group_name, c.n
    FROM base b CROSS JOIN counted c
    ORDER BY
      CASE WHEN v_sort = 'date_desc'   THEN b.transaction_date END DESC,
      CASE WHEN v_sort = 'date_desc'   THEN b.created_at END DESC,
      CASE WHEN v_sort = 'date_asc'    THEN b.transaction_date END ASC,
      CASE WHEN v_sort = 'date_asc'    THEN b.created_at END ASC,
      CASE WHEN v_sort = 'amount_desc' THEN b.amount END DESC,
      CASE WHEN v_sort = 'amount_asc'  THEN b.amount END ASC
    OFFSET GREATEST(p_offset, 0)
    LIMIT v_lim;
END;
$$ LANGUAGE plpgsql;

-- ---------- A3. get_total_dynamic ----------
CREATE OR REPLACE FUNCTION get_total_dynamic(
    p_user_id UUID,
    p_filters JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(total NUMERIC, count BIGINT, period_start DATE, period_end DATE) AS $$
DECLARE
    v_period TEXT := COALESCE(p_filters->>'period', 'this_month');
    v_start DATE; v_end DATE;
    v_type TEXT := COALESCE(NULLIF(p_filters->>'type',''), 'expense');
    v_category TEXT := NULLIF(p_filters->>'category', '');
    v_group TEXT := NULLIF(p_filters->>'group_name', '');
BEGIN
    CASE v_period
        WHEN 'today'      THEN v_start := CURRENT_DATE; v_end := CURRENT_DATE;
        WHEN 'yesterday'  THEN v_start := CURRENT_DATE - 1; v_end := CURRENT_DATE - 1;
        WHEN 'this_week'  THEN v_start := DATE_TRUNC('week', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'this_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'last_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE;
                                v_end := (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 day')::DATE;
        WHEN 'this_year'  THEN v_start := DATE_TRUNC('year', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'custom'     THEN v_start := NULLIF(p_filters->>'start_date','')::DATE;
                                v_end   := NULLIF(p_filters->>'end_date','')::DATE;
        ELSE                   v_start := NULL; v_end := NULL;
    END CASE;

    RETURN QUERY
    SELECT
        COALESCE(SUM(t.amount), 0)::NUMERIC AS total,
        COUNT(*)::BIGINT AS count,
        v_start AS period_start,
        v_end AS period_end
    FROM v_reportable_transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN expense_groups g ON g.id = t.group_id
    WHERE t.user_id = p_user_id
      AND (v_start IS NULL OR t.transaction_date >= v_start)
      AND (v_end   IS NULL OR t.transaction_date <= v_end)
      AND (v_type = 'both' OR t.type = v_type)
      AND (v_category IS NULL OR normalize_text(COALESCE(c.name,'')) % normalize_text(v_category))
      AND (v_group IS NULL OR normalize_text(COALESCE(g.name,'')) % normalize_text(v_group));
END;
$$ LANGUAGE plpgsql;

-- ---------- A4. get_breakdown_dynamic ----------
-- Devuelve agregados agrupados por dimensión: category|day|week|month|payment_method|group
CREATE OR REPLACE FUNCTION get_breakdown_dynamic(
    p_user_id UUID,
    p_dimension TEXT,
    p_filters JSONB DEFAULT '{}'::jsonb,
    p_top_n INT DEFAULT 10
)
RETURNS TABLE(label TEXT, emoji TEXT, total NUMERIC, count BIGINT, pct_of_total NUMERIC) AS $$
DECLARE
    v_period TEXT := COALESCE(p_filters->>'period', 'this_month');
    v_start DATE; v_end DATE;
    v_type TEXT := COALESCE(NULLIF(p_filters->>'type',''), 'expense');
    v_grand NUMERIC;
BEGIN
    CASE v_period
        WHEN 'today'      THEN v_start := CURRENT_DATE; v_end := CURRENT_DATE;
        WHEN 'yesterday'  THEN v_start := CURRENT_DATE - 1; v_end := CURRENT_DATE - 1;
        WHEN 'this_week'  THEN v_start := DATE_TRUNC('week', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'this_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'last_month' THEN v_start := DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE;
                                v_end := (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 day')::DATE;
        WHEN 'this_year'  THEN v_start := DATE_TRUNC('year', CURRENT_DATE)::DATE; v_end := CURRENT_DATE;
        WHEN 'custom'     THEN v_start := NULLIF(p_filters->>'start_date','')::DATE;
                                v_end   := NULLIF(p_filters->>'end_date','')::DATE;
        ELSE                   v_start := NULL; v_end := NULL;
    END CASE;

    SELECT COALESCE(SUM(t.amount), 0) INTO v_grand
    FROM v_reportable_transactions t
    WHERE t.user_id = p_user_id
      AND (v_start IS NULL OR t.transaction_date >= v_start)
      AND (v_end IS NULL OR t.transaction_date <= v_end)
      AND (v_type = 'both' OR t.type = v_type);

    IF v_grand = 0 THEN v_grand := 1; END IF; -- evitar div/0

    RETURN QUERY
    WITH agg AS (
        SELECT
            CASE p_dimension
                WHEN 'category'        THEN COALESCE(NULLIF(c.name, ''), 'Sin categoría')
                WHEN 'day'             THEN TO_CHAR(t.transaction_date, 'YYYY-MM-DD')
                WHEN 'week'            THEN TO_CHAR(DATE_TRUNC('week', t.transaction_date), 'YYYY-"W"IW')
                WHEN 'month'           THEN TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')
                WHEN 'payment_method'  THEN COALESCE(NULLIF(pm.name, ''), 'Sin método')
                WHEN 'group'           THEN COALESCE(NULLIF(g.name, ''), 'Sin grupo')
                ELSE 'Sin grupo'
            END AS label,
            CASE p_dimension WHEN 'category' THEN COALESCE(c.emoji, '🏷️') ELSE NULL END AS emoji,
            SUM(t.amount)::NUMERIC AS total,
            COUNT(*)::BIGINT AS count
        FROM v_reportable_transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
        LEFT JOIN expense_groups g ON g.id = t.group_id
        WHERE t.user_id = p_user_id
          AND (v_start IS NULL OR t.transaction_date >= v_start)
          AND (v_end   IS NULL OR t.transaction_date <= v_end)
          AND (v_type = 'both' OR t.type = v_type)
        GROUP BY 1, 2
        HAVING SUM(t.amount) > 0
    )
    SELECT a.label, a.emoji, a.total, a.count, ROUND((a.total / v_grand * 100)::NUMERIC, 1) AS pct_of_total
    FROM agg a
    WHERE a.label IS NOT NULL AND a.total > 0
    ORDER BY a.total DESC
    LIMIT GREATEST(p_top_n, 1);
END;
$$ LANGUAGE plpgsql;

-- ---------- A5. compare_periods ----------
-- Compara totales entre dos períodos. Útil para "este mes vs el pasado".
CREATE OR REPLACE FUNCTION compare_periods(
    p_user_id UUID,
    p_period_a TEXT,
    p_period_b TEXT,
    p_type TEXT DEFAULT 'expense'
)
RETURNS TABLE(
    label_a TEXT, total_a NUMERIC, count_a BIGINT,
    label_b TEXT, total_b NUMERIC, count_b BIGINT,
    delta_abs NUMERIC, delta_pct NUMERIC
) AS $$
DECLARE
    v_a JSONB; v_b JSONB;
    v_total_a NUMERIC; v_count_a BIGINT;
    v_total_b NUMERIC; v_count_b BIGINT;
BEGIN
    v_a := jsonb_build_object('period', p_period_a, 'type', p_type);
    v_b := jsonb_build_object('period', p_period_b, 'type', p_type);

    SELECT total, count INTO v_total_a, v_count_a FROM get_total_dynamic(p_user_id, v_a);
    SELECT total, count INTO v_total_b, v_count_b FROM get_total_dynamic(p_user_id, v_b);

    RETURN QUERY SELECT
        p_period_a, COALESCE(v_total_a, 0), COALESCE(v_count_a, 0),
        p_period_b, COALESCE(v_total_b, 0), COALESCE(v_count_b, 0),
        (COALESCE(v_total_a, 0) - COALESCE(v_total_b, 0))::NUMERIC AS delta_abs,
        CASE WHEN COALESCE(v_total_b, 0) = 0 THEN NULL
             ELSE ROUND(((v_total_a - v_total_b) / v_total_b * 100)::NUMERIC, 1)
        END AS delta_pct;
END;
$$ LANGUAGE plpgsql;

-- ---------- A6. find_potential_duplicates ----------
-- Detecta gastos repetidos (mismo monto + categoría dentro de N días).
-- Útil para "elimina los gastos repetidos".
CREATE OR REPLACE FUNCTION find_potential_duplicates(
    p_user_id UUID,
    p_window_days INT DEFAULT 7,
    p_min_repetitions INT DEFAULT 2
)
RETURNS TABLE(
    cluster_id INT,
    tx_count BIGINT,
    total_amount NUMERIC,
    sample_amount NUMERIC,
    sample_category TEXT,
    sample_description TEXT,
    earliest_date DATE,
    latest_date DATE,
    transaction_ids UUID[]
) AS $$
BEGIN
    RETURN QUERY
    WITH grouped AS (
        SELECT
            DENSE_RANK() OVER (ORDER BY t.amount, t.category_id, normalize_text(COALESCE(t.description,'')))::INT AS cluster_id,
            t.amount,
            t.category_id,
            c.name AS category_name,
            t.description,
            t.transaction_date,
            t.id,
            (t.transaction_date - LAG(t.transaction_date) OVER (
                PARTITION BY t.amount, t.category_id, normalize_text(COALESCE(t.description,''))
                ORDER BY t.transaction_date
            )) AS gap_days
        FROM v_reportable_transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = p_user_id
          AND t.type = 'expense'
          AND t.transaction_date >= CURRENT_DATE - (p_window_days * 4 || ' days')::INTERVAL
    ),
    clusters AS (
        SELECT g.cluster_id,
               COUNT(*)::BIGINT AS tx_count,
               SUM(g.amount)::NUMERIC AS total_amount,
               (ARRAY_AGG(g.amount))[1]::NUMERIC AS sample_amount,
               (ARRAY_AGG(g.category_name))[1] AS sample_category,
               (ARRAY_AGG(g.description))[1] AS sample_description,
               MIN(g.transaction_date) AS earliest_date,
               MAX(g.transaction_date) AS latest_date,
               ARRAY_AGG(g.id) AS transaction_ids
        FROM grouped g
        GROUP BY g.cluster_id
        HAVING COUNT(*) >= p_min_repetitions
           AND MAX(g.transaction_date) - MIN(g.transaction_date) <= p_window_days
    )
    SELECT cl.cluster_id, cl.tx_count, cl.total_amount, cl.sample_amount,
           cl.sample_category, cl.sample_description, cl.earliest_date, cl.latest_date,
           cl.transaction_ids
    FROM clusters cl
    ORDER BY cl.tx_count DESC, cl.total_amount DESC;
END;
$$ LANGUAGE plpgsql;

-- ---------- A7. bulk_delete_by_ids ----------
-- Borra una lista de transacciones por UUID. Filtro de seguridad: user_id.
-- El agente DEBE pasar la lista explícita; nunca borra por hint.
CREATE OR REPLACE FUNCTION bulk_delete_by_ids(
    p_user_id UUID,
    p_ids UUID[]
)
RETURNS TABLE(deleted_count BIGINT, deleted_total NUMERIC, deleted_ids UUID[]) AS $$
DECLARE
    v_count BIGINT;
    v_total NUMERIC;
    v_ids UUID[];
BEGIN
    WITH del AS (
        DELETE FROM transactions
        WHERE user_id = p_user_id
          AND id = ANY(p_ids)
        RETURNING id, amount
    )
    SELECT COUNT(*)::BIGINT, COALESCE(SUM(amount), 0)::NUMERIC, COALESCE(ARRAY_AGG(id), ARRAY[]::UUID[])
    INTO v_count, v_total, v_ids
    FROM del;

    RETURN QUERY SELECT v_count, v_total, v_ids;
END;
$$ LANGUAGE plpgsql;

-- ---------- A8. bulk_update_by_ids ----------
-- Mismo patron que update_tx: si viene UUID lo usa, si viene hint lo resuelve.
DROP FUNCTION IF EXISTS bulk_update_by_ids(UUID, UUID[], UUID, DATE, UUID, NUMERIC, BOOLEAN);
-- DROP all overloads first — CREATE OR REPLACE solo reemplaza si el signature
-- match exacto. Como agregamos params nuevos, sin DROP queda una vieja firma
-- coexistiendo y los call sites con NULL explotan con "is not unique".
DROP FUNCTION IF EXISTS bulk_update_by_ids(UUID, UUID[], UUID, DATE, UUID, NUMERIC, BOOLEAN);
DROP FUNCTION IF EXISTS bulk_update_by_ids(UUID, UUID[], UUID, DATE, UUID, NUMERIC, BOOLEAN, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS bulk_update_by_ids(UUID, UUID[], UUID, DATE, UUID, NUMERIC, BOOLEAN, TEXT, BOOLEAN, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION bulk_update_by_ids(
    p_user_id UUID,
    p_ids UUID[],
    p_new_category_id UUID DEFAULT NULL,
    p_new_date DATE DEFAULT NULL,
    p_new_group_id UUID DEFAULT NULL,
    p_amount_delta NUMERIC DEFAULT NULL,
    p_set_excluded BOOLEAN DEFAULT NULL,
    p_new_category_hint TEXT DEFAULT NULL,
    p_create_category_if_missing BOOLEAN DEFAULT FALSE,
    p_new_amount NUMERIC DEFAULT NULL,        -- SET absoluto (gana sobre amount_delta)
    p_new_description TEXT DEFAULT NULL       -- SET descripción para todos
)
RETURNS TABLE(updated_count BIGINT, updated_ids UUID[]) AS $$
DECLARE
    v_count BIGINT; v_ids UUID[];
    v_resolved_cat_id UUID := p_new_category_id;
    v_sample_type TEXT;
BEGIN
    IF v_resolved_cat_id IS NULL AND COALESCE(p_new_category_hint, '') <> '' THEN
        -- Inferimos el tipo dominante de las transacciones del batch para la resolucion
        SELECT type INTO v_sample_type
        FROM transactions
        WHERE user_id = p_user_id AND id = ANY(p_ids)
        GROUP BY type
        ORDER BY COUNT(*) DESC
        LIMIT 1;

        IF p_create_category_if_missing THEN
            SELECT category_id INTO v_resolved_cat_id
            FROM resolve_or_create_category(p_user_id, p_new_category_hint, COALESCE(v_sample_type, 'expense'));
        ELSE
            SELECT category_id INTO v_resolved_cat_id
            FROM find_best_category(p_user_id, p_new_category_hint, COALESCE(v_sample_type, 'expense'));
        END IF;
    END IF;

    WITH upd AS (
        UPDATE transactions t
        SET category_id = COALESCE(v_resolved_cat_id, t.category_id),
            transaction_date = COALESCE(p_new_date, t.transaction_date),
            group_id = COALESCE(p_new_group_id, t.group_id),
            amount = CASE
                WHEN p_new_amount   IS NOT NULL THEN p_new_amount
                WHEN p_amount_delta IS NOT NULL THEN t.amount + p_amount_delta
                ELSE t.amount
            END,
            description = COALESCE(NULLIF(p_new_description, ''), t.description),
            excluded_from_reports = COALESCE(p_set_excluded, t.excluded_from_reports),
            updated_at = NOW()
        WHERE t.user_id = p_user_id AND t.id = ANY(p_ids)
        RETURNING t.id
    )
    SELECT COUNT(*)::BIGINT, COALESCE(ARRAY_AGG(id), ARRAY[]::UUID[])
    INTO v_count, v_ids FROM upd;
    RETURN QUERY SELECT v_count, v_ids;
END;
$$ LANGUAGE plpgsql;

-- ---------- A9. bulk_preview ----------
-- Previo a borrar/editar masivamente: cuenta y muestra primeros 10.
-- Acepta los mismos filtros que query_tx_dynamic.
CREATE OR REPLACE FUNCTION bulk_preview(
    p_user_id UUID,
    p_filters JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(
    would_match_count BIGINT,
    would_match_total NUMERIC,
    sample_ids UUID[],
    preview JSONB
) AS $$
DECLARE
    v_count BIGINT; v_total NUMERIC; v_ids UUID[]; v_preview JSONB;
BEGIN
    WITH matches AS (
        SELECT q.id, q.transaction_date, q.amount, q.description, q.category_name, q.category_emoji
        FROM query_tx_dynamic(p_user_id, p_filters, 10000, 0) q
    ),
    samp AS (
        SELECT id, transaction_date, amount, description, category_name, category_emoji
        FROM matches LIMIT 10
    )
    SELECT
        (SELECT COUNT(*)::BIGINT FROM matches),
        (SELECT COALESCE(SUM(amount),0)::NUMERIC FROM matches),
        (SELECT COALESCE(ARRAY_AGG(id), ARRAY[]::UUID[]) FROM matches),
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id,
            'date', transaction_date,
            'amount', amount,
            'description', description,
            'category', category_name,
            'emoji', category_emoji
         )), '[]'::jsonb) FROM samp)
    INTO v_count, v_total, v_ids, v_preview;

    RETURN QUERY SELECT v_count, v_total, v_ids, v_preview;
END;
$$ LANGUAGE plpgsql;

-- ---------- A10. remember_last_list ----------
-- Guarda una lista mostrada al usuario en conversation_state.context.last_list
-- para resolver referencias deícticas ("borrá los 2 primeros", "esos").
CREATE OR REPLACE FUNCTION remember_last_list(
    p_user_id UUID,
    p_kind TEXT,
    p_items JSONB,
    p_filters JSONB DEFAULT '{}'::jsonb,
    p_ttl_seconds INT DEFAULT 600
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO conversation_state (user_id, state, context, expires_at)
    VALUES (
        p_user_id,
        'has_last_list',
        jsonb_build_object(
            'last_list', jsonb_build_object(
                'kind', p_kind,
                'items', p_items,
                'shown_at', NOW(),
                'filters_applied', p_filters
            )
        ),
        NOW() + (p_ttl_seconds || ' seconds')::INTERVAL
    )
    ON CONFLICT (user_id) DO UPDATE
    SET context = COALESCE(conversation_state.context, '{}'::jsonb)
                  || jsonb_build_object(
                      'last_list', jsonb_build_object(
                          'kind', p_kind,
                          'items', p_items,
                          'shown_at', NOW(),
                          'filters_applied', p_filters
                      )
                  ),
        expires_at = NOW() + (p_ttl_seconds || ' seconds')::INTERVAL,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ---------- A11. get_last_list ----------
CREATE OR REPLACE FUNCTION get_last_list(p_user_id UUID)
RETURNS TABLE(kind TEXT, items JSONB, shown_at TIMESTAMPTZ, filters_applied JSONB, is_fresh BOOLEAN) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cs.context->'last_list'->>'kind',
        cs.context->'last_list'->'items',
        (cs.context->'last_list'->>'shown_at')::TIMESTAMPTZ,
        cs.context->'last_list'->'filters_applied',
        (cs.expires_at > NOW())
    FROM conversation_state cs
    WHERE cs.user_id = p_user_id
      AND cs.context ? 'last_list';
END;
$$ LANGUAGE plpgsql;

-- ---------- A12. list_categories_with_counts ----------
CREATE OR REPLACE FUNCTION list_categories_with_counts(
    p_user_id UUID,
    p_type TEXT DEFAULT NULL,
    p_include_excluded BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    id UUID, name TEXT, emoji TEXT, type TEXT,
    excluded BOOLEAN, tx_count BIGINT, total_amount NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT c.id, c.name, c.emoji, c.type,
           c.excluded_from_reports,
           COUNT(t.id)::BIGINT,
           COALESCE(SUM(t.amount), 0)::NUMERIC
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = c.user_id
    WHERE c.user_id = p_user_id
      AND c.is_active = TRUE
      AND (p_type IS NULL OR p_type = 'both' OR c.type = p_type)
      AND (p_include_excluded OR c.excluded_from_reports = FALSE)
    GROUP BY c.id, c.name, c.emoji, c.type, c.excluded_from_reports
    ORDER BY c.type DESC, total_amount DESC, c.name;
END;
$$ LANGUAGE plpgsql;

-- ---------- A13. Índices de soporte para el agente ----------
CREATE INDEX IF NOT EXISTS idx_tx_user_amount_date
    ON transactions(user_id, amount, transaction_date);

CREATE INDEX IF NOT EXISTS idx_tx_user_date_type
    ON transactions(user_id, transaction_date DESC, type);

-- Trigram index sobre description directo (sin normalize_text para que sea IMMUTABLE).
-- Acelera búsquedas con `ILIKE '%foo%'` y `% similarity` en description.
CREATE INDEX IF NOT EXISTS idx_tx_desc_trgm
    ON transactions USING GIN (description gin_trgm_ops);

-- ---------- A13b. resolve_or_create_category ----------
-- Busca categoría existente; si no existe, la crea con kebab del nombre y emoji 🏷️.
-- Útil cuando el usuario nombra una categoría libre que tal vez no existe.
CREATE OR REPLACE FUNCTION resolve_or_create_category(
    p_user_id UUID,
    p_name TEXT,
    p_type TEXT DEFAULT 'expense'
)
RETURNS TABLE(category_id UUID, category_name TEXT, was_created BOOLEAN) AS $$
DECLARE
    v_id UUID;
    v_name TEXT;
    v_norm TEXT := normalize_text(p_name);
BEGIN
    IF v_norm IS NULL OR v_norm = '' THEN
        SELECT c.id, c.name INTO v_id, v_name
        FROM categories c
        WHERE c.user_id = p_user_id AND c.normalized_name = 'otros' AND c.type = p_type
        LIMIT 1;
        RETURN QUERY SELECT v_id, v_name, FALSE;
        RETURN;
    END IF;

    -- exact normalized match (incl. inactive: lo reactivamos en vez de duplicar)
    SELECT c.id, c.name INTO v_id, v_name
    FROM categories c
    WHERE c.user_id = p_user_id AND c.type = p_type
      AND c.normalized_name = v_norm
    ORDER BY c.is_active DESC
    LIMIT 1;
    IF v_id IS NOT NULL THEN
        UPDATE categories SET is_active = TRUE, updated_at = NOW()
        WHERE id = v_id AND NOT is_active;
        RETURN QUERY SELECT v_id, v_name, FALSE;
        RETURN;
    END IF;

    -- Fuzzy match SOLO si el input es un token simple (puro alfabético, sin
    -- guiones / espacios / dígitos). Eso permite colapsar inflexiones ("comidas"
    -- → "Comida") sin colapsar nombres compuestos distintivos
    -- ("mascotas-test", "viaje 2026") que el usuario quiere preservar.
    IF v_norm ~ '^[a-zñáéíóúüç]+$' THEN
        SELECT c.id, c.name INTO v_id, v_name
        FROM categories c
        WHERE c.user_id = p_user_id AND c.is_active AND c.type = p_type
          AND similarity(c.normalized_name, v_norm) >= 0.6
        ORDER BY similarity(c.normalized_name, v_norm) DESC
        LIMIT 1;
        IF v_id IS NOT NULL THEN
            RETURN QUERY SELECT v_id, v_name, FALSE;
            RETURN;
        END IF;
    END IF;

    -- create new (no exact match, no fuzzy aplicable o no encontrado)
    INSERT INTO categories (user_id, name, normalized_name, emoji, color, keywords, type, is_active)
    VALUES (p_user_id, INITCAP(p_name), v_norm, '🏷️', '#888888', ARRAY[]::TEXT[], p_type, TRUE)
    RETURNING id, name INTO v_id, v_name;
    RETURN QUERY SELECT v_id, v_name, TRUE;
END;
$$ LANGUAGE plpgsql;

-- ---------- A13c. rename_category ----------
-- Renombra una categoría existente. El nombre nuevo debe ser único por (user_id, type).
CREATE OR REPLACE FUNCTION rename_category(
    p_user_id UUID,
    p_old_name TEXT,
    p_new_name TEXT
)
RETURNS TABLE(category_id UUID, old_name TEXT, new_name TEXT, renamed BOOLEAN) AS $$
DECLARE
    v_id UUID;
    v_old TEXT;
    v_norm_new TEXT := normalize_text(p_new_name);
    v_conflict UUID;
    v_type TEXT;
BEGIN
    -- Find the category by old name (exact or fuzzy)
    SELECT c.id, c.name, c.type INTO v_id, v_old, v_type
    FROM categories c
    WHERE c.user_id = p_user_id AND c.is_active
      AND (c.normalized_name = normalize_text(p_old_name)
           OR similarity(c.normalized_name, normalize_text(p_old_name)) >= 0.5)
    ORDER BY (c.normalized_name = normalize_text(p_old_name)) DESC,
             similarity(c.normalized_name, normalize_text(p_old_name)) DESC
    LIMIT 1;
    IF v_id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_old_name, p_new_name, FALSE;
        RETURN;
    END IF;

    -- Check for conflict with existing category that has the new name
    SELECT id INTO v_conflict
    FROM categories
    WHERE user_id = p_user_id AND is_active
      AND normalized_name = v_norm_new AND type = v_type AND id <> v_id
    LIMIT 1;
    IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION 'Ya existe una categoría con el nombre "%". Para fusionar usá merge_categories.', p_new_name;
    END IF;

    UPDATE categories
    SET name = INITCAP(p_new_name),
        normalized_name = v_norm_new,
        updated_at = NOW()
    WHERE id = v_id;

    RETURN QUERY SELECT v_id, v_old, INITCAP(p_new_name), TRUE;
END;
$$ LANGUAGE plpgsql;

-- ---------- A13d. merge_categories ----------
-- Fusiona la categoría source dentro de target: mueve todas las transacciones,
-- presupuestos, recurrentes, learning. Después desactiva la source.
CREATE OR REPLACE FUNCTION merge_categories(
    p_user_id UUID,
    p_source_name TEXT,
    p_target_name TEXT
)
RETURNS TABLE(
    source_id UUID, target_id UUID,
    moved_transactions INT, moved_budgets INT, moved_recurring INT,
    success BOOLEAN
) AS $$
DECLARE
    v_src UUID; v_src_type TEXT;
    v_tgt UUID; v_tgt_type TEXT;
    v_moved_tx INT; v_moved_bd INT; v_moved_rec INT;
BEGIN
    SELECT id, type INTO v_src, v_src_type
    FROM categories
    WHERE user_id = p_user_id AND is_active
      AND normalized_name = normalize_text(p_source_name)
    LIMIT 1;
    IF v_src IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, 0, 0, 0, FALSE;
        RETURN;
    END IF;

    SELECT id, type INTO v_tgt, v_tgt_type
    FROM categories
    WHERE user_id = p_user_id AND is_active
      AND normalized_name = normalize_text(p_target_name)
    LIMIT 1;
    IF v_tgt IS NULL THEN
        RAISE EXCEPTION 'La categoría destino "%" no existe. Crealá primero o usá rename_category.', p_target_name;
    END IF;
    IF v_src = v_tgt THEN
        RAISE EXCEPTION 'No podés fusionar una categoría consigo misma.';
    END IF;
    IF v_src_type <> v_tgt_type THEN
        RAISE EXCEPTION 'No podés fusionar una categoría de % con una de %.', v_src_type, v_tgt_type;
    END IF;

    UPDATE transactions SET category_id = v_tgt, updated_at = NOW()
    WHERE transactions.user_id = p_user_id AND transactions.category_id = v_src;
    GET DIAGNOSTICS v_moved_tx = ROW_COUNT;

    -- Budgets: handle period collisions step by step (no chained CTE updates).
    -- 1) For each (period) where target already has a budget: keep the larger, then drop the source's.
    UPDATE budgets tgt
    SET amount = src.amount, updated_at = NOW()
    FROM budgets src
    WHERE tgt.user_id = p_user_id
      AND tgt.category_id = v_tgt
      AND src.user_id = p_user_id
      AND src.category_id = v_src
      AND tgt.period = src.period
      AND src.amount > tgt.amount;

    -- 2) Delete source budgets where a target budget for the same period exists
    DELETE FROM budgets src
    WHERE src.user_id = p_user_id
      AND src.category_id = v_src
      AND EXISTS (
          SELECT 1 FROM budgets tgt
          WHERE tgt.user_id = p_user_id
            AND tgt.category_id = v_tgt
            AND tgt.period = src.period
      );

    -- 3) Move the rest (no period conflict)
    UPDATE budgets SET category_id = v_tgt, updated_at = NOW()
    WHERE budgets.user_id = p_user_id AND budgets.category_id = v_src;
    GET DIAGNOSTICS v_moved_bd = ROW_COUNT;

    UPDATE recurring_transactions SET category_id = v_tgt
    WHERE recurring_transactions.user_id = p_user_id AND recurring_transactions.category_id = v_src;
    GET DIAGNOSTICS v_moved_rec = ROW_COUNT;

    UPDATE category_learning
    SET final_category_id = v_tgt,
        matched_category_id = CASE WHEN matched_category_id = v_src THEN v_tgt ELSE matched_category_id END
    WHERE category_learning.user_id = p_user_id
      AND (category_learning.final_category_id = v_src OR category_learning.matched_category_id = v_src);

    -- Deactivate source
    UPDATE categories SET is_active = FALSE, updated_at = NOW() WHERE id = v_src;

    RETURN QUERY SELECT v_src, v_tgt, v_moved_tx, v_moved_bd, v_moved_rec, TRUE;
END;
$$ LANGUAGE plpgsql;

-- ---------- A13e. delete_category ----------
-- Borra (soft-delete) una categoria del usuario. Si tiene transacciones u otras
-- dependencias y no se pasa merge_into, falla con un error claro. Si se pasa
-- merge_into, primero fusiona y despues desactiva. Nunca toca categorias de otros usuarios.
CREATE OR REPLACE FUNCTION delete_category(
    p_user_id UUID,
    p_name TEXT,
    p_merge_into TEXT DEFAULT NULL
)
RETURNS TABLE(
    category_id UUID,
    category_name TEXT,
    deactivated BOOLEAN,
    merged_into TEXT,
    moved_transactions INT
) AS $$
DECLARE
    v_id UUID; v_name TEXT; v_type TEXT;
    v_tx_count INT; v_bud_count INT; v_rec_count INT;
    v_merge RECORD;
BEGIN
    SELECT c.id, c.name, c.type INTO v_id, v_name, v_type
    FROM categories c
    WHERE c.user_id = p_user_id AND c.is_active
      AND (c.normalized_name = normalize_text(p_name)
           OR similarity(c.normalized_name, normalize_text(p_name)) >= 0.5)
    ORDER BY (c.normalized_name = normalize_text(p_name)) DESC,
             similarity(c.normalized_name, normalize_text(p_name)) DESC
    LIMIT 1;

    IF v_id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_name, FALSE, NULL::TEXT, 0;
        RETURN;
    END IF;

    -- Si pidieron merge, delegamos en merge_categories y devolvemos el resultado
    IF COALESCE(p_merge_into, '') <> '' THEN
        SELECT * INTO v_merge FROM merge_categories(p_user_id, v_name, p_merge_into);
        RETURN QUERY SELECT v_id, v_name, TRUE, p_merge_into, COALESCE(v_merge.moved_transactions, 0);
        RETURN;
    END IF;

    -- Sin merge: chequear dependencias (qualify cols: OUT params sombrean)
    SELECT COUNT(*)::INT INTO v_tx_count
    FROM transactions t WHERE t.user_id = p_user_id AND t.category_id = v_id;
    SELECT COUNT(*)::INT INTO v_bud_count
    FROM budgets b WHERE b.user_id = p_user_id AND b.category_id = v_id AND b.is_active;
    SELECT COUNT(*)::INT INTO v_rec_count
    FROM recurring_transactions r
    WHERE r.user_id = p_user_id AND r.category_id = v_id AND r.is_active;

    IF v_tx_count > 0 OR v_bud_count > 0 OR v_rec_count > 0 THEN
        RAISE EXCEPTION 'La categoría "%" tiene % transacciones, % presupuestos y % recurrentes. Pasá merge_into para fusionarla en otra categoría.',
            v_name, v_tx_count, v_bud_count, v_rec_count;
    END IF;

    UPDATE categories cc SET is_active = FALSE, updated_at = NOW() WHERE cc.id = v_id;
    RETURN QUERY SELECT v_id, v_name, TRUE, NULL::TEXT, 0;
END;
$$ LANGUAGE plpgsql;

-- ---------- A14. LangChain Postgres Chat Memory ----------
-- Tabla que usa @n8n/n8n-nodes-langchain.memoryPostgresChat para persistir
-- el historial conversacional por session_id (= user_id en nuestro caso).
CREATE TABLE IF NOT EXISTS n8n_chat_histories (
    id          SERIAL PRIMARY KEY,
    session_id  TEXT NOT NULL,
    message     JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_session
    ON n8n_chat_histories(session_id, id);

-- Job de retención: borra historial >30 días en cada cleanup.
CREATE OR REPLACE FUNCTION purge_old_chat_history(p_days INT DEFAULT 30)
RETURNS BIGINT AS $$
DECLARE v_deleted BIGINT;
BEGIN
    WITH d AS (
        DELETE FROM n8n_chat_histories
        WHERE created_at < NOW() - (p_days || ' days')::INTERVAL
        RETURNING 1
    )
    SELECT COUNT(*)::BIGINT INTO v_deleted FROM d;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ---------- A15. Cron run log (observabilidad de los jobs cron) ----------
CREATE TABLE IF NOT EXISTS cron_runs (
    id           SERIAL PRIMARY KEY,
    job_name     TEXT NOT NULL,
    started_at   TIMESTAMPTZ DEFAULT NOW(),
    finished_at  TIMESTAMPTZ,
    items_processed INT DEFAULT 0,
    items_sent   INT DEFAULT 0,
    success      BOOLEAN,
    error_msg    TEXT,
    metadata     JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
    ON cron_runs(job_name, started_at DESC);

CREATE OR REPLACE FUNCTION log_cron_start(p_job TEXT, p_meta JSONB DEFAULT '{}'::jsonb)
RETURNS INT AS $$
DECLARE v_id INT;
BEGIN
    INSERT INTO cron_runs (job_name, metadata) VALUES (p_job, p_meta)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION log_cron_end(
    p_run_id INT,
    p_items_processed INT DEFAULT 0,
    p_items_sent INT DEFAULT 0,
    p_success BOOLEAN DEFAULT TRUE,
    p_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE cron_runs
    SET finished_at = NOW(),
        items_processed = p_items_processed,
        items_sent = p_items_sent,
        success = p_success,
        error_msg = p_error
    WHERE id = p_run_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- A16. Cleanup periódico de conversation_state expirado ----------
CREATE OR REPLACE FUNCTION purge_expired_conv_states()
RETURNS BIGINT AS $$
DECLARE v_deleted BIGINT;
BEGIN
    WITH d AS (
        DELETE FROM conversation_state
        WHERE expires_at < NOW() - INTERVAL '1 hour'
        RETURNING 1
    )
    SELECT COUNT(*)::BIGINT INTO v_deleted FROM d;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ---------- A17. Budget alerts cron (notifica acercamiento/exceso) ----------
-- Devuelve usuarios + categorías que cruzaron el umbral de 80% o 100%
-- en el período del presupuesto, y NO fueron notificados en las últimas 18 horas.
CREATE TABLE IF NOT EXISTS budget_alert_log (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_id   UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    level       TEXT NOT NULL,
    notified_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_alert_log_user_budget
    ON budget_alert_log(user_id, budget_id, notified_at DESC);

-- (pending_budget_alerts: defined later with richer columns)

CREATE OR REPLACE FUNCTION mark_budget_alert_sent(
    p_user_id UUID, p_budget_id UUID, p_level TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO budget_alert_log (user_id, budget_id, level)
    VALUES (p_user_id, p_budget_id, p_level);
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- A18. Cashflow / Saldo (graceful degradation when no income)
-- =====================================================================
-- Helper: ¿el usuario cargó al menos un ingreso alguna vez?
-- Si devuelve FALSE, todos los componentes de cashflow degradan en lugar de romper.
CREATE OR REPLACE FUNCTION user_has_income(p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM transactions
        WHERE user_id = p_user_id AND type = 'income'
    );
$$ LANGUAGE SQL STABLE;

-- Cashflow del período (income, expenses, net, ritmo diario).
-- Si has_income=FALSE, income/net vienen NULL — el caller debe manejar el caso.
CREATE OR REPLACE FUNCTION get_cashflow(
    p_user_id UUID,
    p_period_start DATE DEFAULT DATE_TRUNC('month', CURRENT_DATE)::DATE,
    p_period_end   DATE DEFAULT (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::DATE
)
RETURNS TABLE(
    has_income       BOOLEAN,
    income           NUMERIC,
    expenses         NUMERIC,
    net              NUMERIC,
    days_in_period   INT,
    days_elapsed     INT,
    days_remaining   INT,
    daily_burn_rate  NUMERIC
) AS $$
DECLARE
    v_has_income BOOLEAN;
    v_today      DATE := CURRENT_DATE;
    v_elapsed    INT  := GREATEST(0, LEAST(p_period_end, v_today) - p_period_start + 1);
    v_remaining  INT  := GREATEST(0, p_period_end - GREATEST(p_period_start, v_today) + 1);
BEGIN
    v_has_income := user_has_income(p_user_id);

    RETURN QUERY
    WITH agg AS (
        SELECT
            COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'),  0) AS sum_income,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0) AS sum_expense
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id
          AND t.transaction_date BETWEEN p_period_start AND p_period_end
    )
    SELECT
        v_has_income,
        CASE WHEN v_has_income THEN agg.sum_income END,
        agg.sum_expense,
        CASE WHEN v_has_income THEN agg.sum_income - agg.sum_expense END,
        (p_period_end - p_period_start + 1)::INT,
        v_elapsed,
        v_remaining,
        CASE WHEN v_elapsed > 0
             THEN ROUND((agg.sum_expense / v_elapsed)::NUMERIC, 2)
             ELSE 0::NUMERIC END
    FROM agg;
END;
$$ LANGUAGE plpgsql STABLE;

-- Proyección de gasto a fin de mes basada en burn rate de los últimos N días.
-- NO requiere ingresos — funciona siempre que haya gastos en el lookback.
CREATE OR REPLACE FUNCTION forecast_month_end(
    p_user_id UUID,
    p_lookback_days INT DEFAULT 14
)
RETURNS TABLE(
    has_data        BOOLEAN,
    burn_rate_daily NUMERIC,
    spent_so_far    NUMERIC,
    days_remaining  INT,
    forecast_total  NUMERIC
) AS $$
DECLARE
    v_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    v_month_end   DATE := (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_today       DATE := CURRENT_DATE;
    v_lookback    DATE := v_today - (p_lookback_days - 1);
    v_remaining   INT  := GREATEST(0, v_month_end - v_today);
BEGIN
    RETURN QUERY
    WITH spent_lb AS (
        SELECT COALESCE(SUM(t.amount), 0) AS s, COUNT(*) AS n
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id AND t.type = 'expense'
          AND t.transaction_date BETWEEN v_lookback AND v_today
    ),
    spent_so_far AS (
        SELECT COALESCE(SUM(t.amount), 0) AS s
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id AND t.type = 'expense'
          AND t.transaction_date BETWEEN v_month_start AND v_today
    )
    SELECT
        (spent_lb.n > 0)                                                  AS has_data,
        ROUND((spent_lb.s / GREATEST(p_lookback_days, 1))::NUMERIC, 2)    AS burn_rate_daily,
        spent_so_far.s                                                    AS spent_so_far,
        v_remaining                                                       AS days_remaining,
        ROUND((spent_so_far.s + (spent_lb.s / GREATEST(p_lookback_days, 1)) * v_remaining)::NUMERIC, 2) AS forecast_total
    FROM spent_lb, spent_so_far;
END;
$$ LANGUAGE plpgsql STABLE;

-- "Cuánto puedo gastar por día sin pasarme" — REQUIERE ingresos cargados.
-- Si no hay, has_income=FALSE y todos los numéricos NULL (no rompe nada).
CREATE OR REPLACE FUNCTION safe_to_spend(p_user_id UUID)
RETURNS TABLE(
    has_income     BOOLEAN,
    income         NUMERIC,
    spent          NUMERIC,
    remaining      NUMERIC,
    days_remaining INT,
    safe_daily     NUMERIC
) AS $$
DECLARE
    v_has_income     BOOLEAN;
    v_month_start    DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    v_month_end      DATE := (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_today          DATE := CURRENT_DATE;
    v_days_remaining INT  := GREATEST(0, v_month_end - v_today + 1);
BEGIN
    v_has_income := user_has_income(p_user_id);
    IF NOT v_has_income THEN
        RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT, NULL::NUMERIC;
        RETURN;
    END IF;
    RETURN QUERY
    WITH agg AS (
        SELECT
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='income'  AND t.transaction_date BETWEEN v_month_start AND v_month_end), 0) AS inc,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.transaction_date BETWEEN v_month_start AND v_today),     0) AS exp
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id
    )
    SELECT
        TRUE,
        agg.inc,
        agg.exp,
        agg.inc - agg.exp,
        v_days_remaining,
        CASE WHEN v_days_remaining > 0
             THEN ROUND(((agg.inc - agg.exp) / v_days_remaining)::NUMERIC, 2)
             ELSE 0::NUMERIC END
    FROM agg;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- A19. Subscription detection (patrones recurrentes invisibles)
-- =====================================================================
-- Heurística: agrupa por descripción normalizada + monto en bucket de 100.
-- Marca como suscripción candidata si hay ≥3 cargos cuyo intervalo promedio
-- cae cerca de una cadencia canónica (1/7/14/30/60/90/365 días).
CREATE OR REPLACE FUNCTION detect_subscriptions(
    p_user_id UUID,
    p_lookback_days INT DEFAULT 90
)
RETURNS TABLE(
    merchant_key        TEXT,
    sample_description  TEXT,
    category_name       TEXT,
    avg_amount          NUMERIC,
    occurrences         INT,
    cadence_days        INT,
    cadence_label       TEXT,
    last_charge_date    DATE,
    next_estimated_date DATE,
    confidence          NUMERIC,
    sample_ids          UUID[]
) AS $$
DECLARE
    v_since DATE := CURRENT_DATE - p_lookback_days;
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT t.id, t.amount, t.transaction_date, t.description, t.category_id,
               normalize_text(COALESCE(t.description, '')) AS desc_norm,
               ROUND(t.amount, -2)::NUMERIC AS amt_bucket
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id
          AND t.type = 'expense'
          AND t.transaction_date >= v_since
          AND COALESCE(t.description, '') <> ''
    ),
    grouped AS (
        SELECT
            base.desc_norm  AS k_desc,
            base.amt_bucket AS k_amt,
            (ARRAY_AGG(base.id          ORDER BY base.transaction_date DESC))[1:5] AS ids,
            (ARRAY_AGG(base.category_id ORDER BY base.transaction_date DESC))[1]   AS cat_id,
            (ARRAY_AGG(base.description ORDER BY base.transaction_date DESC))[1]   AS sample_desc,
            ROUND(AVG(base.amount)::NUMERIC, 2)                                    AS avg_amt,
            COUNT(*)                                                               AS n,
            MAX(base.transaction_date)                                             AS last_dt,
            MIN(base.transaction_date)                                             AS first_dt,
            CASE WHEN COUNT(*) >= 2
                 THEN (MAX(base.transaction_date) - MIN(base.transaction_date))::NUMERIC / NULLIF(COUNT(*) - 1, 0)
                 ELSE NULL END AS avg_interval_days
        FROM base
        GROUP BY base.desc_norm, base.amt_bucket
        HAVING COUNT(*) >= 3
    ),
    classified AS (
        SELECT g.*,
            CASE
                WHEN g.avg_interval_days BETWEEN 1   AND 2    THEN 1
                WHEN g.avg_interval_days BETWEEN 6   AND 8    THEN 7
                WHEN g.avg_interval_days BETWEEN 13  AND 16   THEN 14
                WHEN g.avg_interval_days BETWEEN 27  AND 33   THEN 30
                WHEN g.avg_interval_days BETWEEN 58  AND 64   THEN 60
                WHEN g.avg_interval_days BETWEEN 88  AND 95   THEN 90
                WHEN g.avg_interval_days BETWEEN 360 AND 370  THEN 365
                ELSE NULL
            END AS canon_days
        FROM grouped g
    )
    SELECT
        c.k_desc,
        c.sample_desc,
        cat.name,
        c.avg_amt,
        c.n::INT,
        c.canon_days::INT,
        CASE c.canon_days
            WHEN 1   THEN 'diaria'
            WHEN 7   THEN 'semanal'
            WHEN 14  THEN 'quincenal'
            WHEN 30  THEN 'mensual'
            WHEN 60  THEN 'bimestral'
            WHEN 90  THEN 'trimestral'
            WHEN 365 THEN 'anual'
        END,
        c.last_dt,
        (c.last_dt + c.canon_days)::DATE,
        ROUND(LEAST(1.0, c.n::NUMERIC / 6.0)::NUMERIC, 2),
        c.ids
    FROM classified c
    LEFT JOIN categories cat ON cat.id = c.cat_id
    WHERE c.canon_days IS NOT NULL
    ORDER BY c.avg_amt DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Log de suscripciones notificadas (dedup en cron mensual).
CREATE TABLE IF NOT EXISTS subscription_notice_log (
    id           SERIAL PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_key TEXT NOT NULL,
    cadence_days INT  NOT NULL,
    notified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, merchant_key, cadence_days)
);

-- =====================================================================
-- A20. Anomaly detection
-- =====================================================================
CREATE TABLE IF NOT EXISTS anomaly_alert_log (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('transaction','category_day')),
    ref_id      TEXT NOT NULL,
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_anomaly_alert_log_user ON anomaly_alert_log(user_id, notified_at DESC);

-- Detecta dos clases de anomalías para la fecha objetivo:
--   1. Transacción individual con monto > avg+2σ y > 1.5x avg (categoría con ≥5 puntos).
--   2. Categoría cuyo gasto del día > 2.5x el promedio diario histórico (≥10 puntos).
CREATE OR REPLACE FUNCTION detect_anomalies(
    p_user_id UUID,
    p_target_date DATE DEFAULT CURRENT_DATE,
    p_lookback_days INT DEFAULT 60
)
RETURNS TABLE(
    kind             TEXT,
    transaction_id   UUID,
    category_id      UUID,
    category_name    TEXT,
    amount           NUMERIC,
    baseline         NUMERIC,
    multiplier       NUMERIC,
    description      TEXT,
    transaction_date DATE
) AS $$
DECLARE
    v_since DATE := p_target_date - p_lookback_days;
BEGIN
    RETURN QUERY
    WITH cat_stats AS (
        SELECT t.category_id,
               AVG(t.amount)::NUMERIC AS avg_amt,
               STDDEV_SAMP(t.amount)::NUMERIC AS sd_amt,
               COUNT(*) AS n
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id AND t.type = 'expense'
          AND t.transaction_date BETWEEN v_since AND p_target_date - 1
        GROUP BY t.category_id
        HAVING COUNT(*) >= 5
    ),
    today_tx AS (
        SELECT t.id, t.category_id, t.amount, t.description, t.transaction_date
        FROM v_reportable_transactions t
        WHERE t.user_id = p_user_id AND t.type = 'expense'
          AND t.transaction_date = p_target_date
    )
    SELECT
        'transaction'::TEXT,
        tt.id,
        tt.category_id,
        c.name,
        tt.amount,
        ROUND(cs.avg_amt, 2),
        ROUND((tt.amount / NULLIF(cs.avg_amt, 0))::NUMERIC, 2),
        tt.description,
        tt.transaction_date
    FROM today_tx tt
    JOIN cat_stats cs ON cs.category_id = tt.category_id
    LEFT JOIN categories c ON c.id = tt.category_id
    WHERE tt.amount > cs.avg_amt + 2 * COALESCE(cs.sd_amt, 0)
      AND tt.amount > cs.avg_amt * 1.5

    UNION ALL

    SELECT
        'category_day'::TEXT,
        NULL::UUID,
        cd.cat_id,
        cd.cat_name,
        cd.day_sum,
        ROUND(cd.daily_avg, 2),
        ROUND((cd.day_sum / NULLIF(cd.daily_avg, 0))::NUMERIC, 2),
        NULL::TEXT,
        p_target_date
    FROM (
        SELECT
            t.category_id AS cat_id,
            c.name        AS cat_name,
            SUM(t.amount) FILTER (WHERE t.transaction_date = p_target_date) AS day_sum,
            (SUM(t.amount) FILTER (WHERE t.transaction_date BETWEEN v_since AND p_target_date - 1))
                / NULLIF(p_lookback_days, 0)::NUMERIC AS daily_avg,
            COUNT(*) FILTER (WHERE t.transaction_date BETWEEN v_since AND p_target_date - 1) AS hist_n
        FROM v_reportable_transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = p_user_id AND t.type = 'expense'
          AND t.transaction_date BETWEEN v_since AND p_target_date
        GROUP BY t.category_id, c.name
    ) cd
    WHERE cd.day_sum   IS NOT NULL
      AND cd.daily_avg IS NOT NULL
      AND cd.hist_n   >= 10
      AND cd.day_sum  > cd.daily_avg * 2.5;
END;
$$ LANGUAGE plpgsql STABLE;

-- Anomalías de un período (para el agente: "qué gastos raros tuve este mes").
CREATE OR REPLACE FUNCTION list_anomalies(
    p_user_id UUID,
    p_start DATE DEFAULT DATE_TRUNC('month', CURRENT_DATE)::DATE,
    p_end   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE(
    transaction_id   UUID,
    category_name    TEXT,
    amount           NUMERIC,
    baseline         NUMERIC,
    multiplier       NUMERIC,
    description      TEXT,
    transaction_date DATE
) AS $$
DECLARE
    v_d DATE;
BEGIN
    FOR v_d IN SELECT generate_series(p_start, p_end, INTERVAL '1 day')::DATE LOOP
        RETURN QUERY
        SELECT a.transaction_id, a.category_name, a.amount, a.baseline, a.multiplier, a.description, a.transaction_date
        FROM detect_anomalies(p_user_id, v_d, 60) a
        WHERE a.kind = 'transaction';
    END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- A21. Smart budget alerts (4 tiers, pacing-aware, daily cap, with safe_daily)
-- =====================================================================
-- Reemplaza pending_budget_alerts() con un sistema de tiers:
--   1 = pacing_warn   (real >= 50% pero pacing < 40%, "vas adelantado")
--   2 = near_budget   (real >= 80%)
--   3 = over_budget   (real >= 100%)
--   4 = over_critical (real >= 120%)
-- Reglas:
--   - 1 alerta por presupuesto cada 24 h (cap de fatiga).
--   - Solo escala: dentro del mismo período, no repite mismo tier ni uno menor.
DROP FUNCTION IF EXISTS pending_budget_alerts() CASCADE;
CREATE OR REPLACE FUNCTION pending_budget_alerts()
RETURNS TABLE(
    user_id          UUID,
    phone            TEXT,
    budget_id        UUID,
    category_name    TEXT,
    category_emoji   TEXT,
    amount           NUMERIC,
    period           TEXT,
    spent            NUMERIC,
    pct              INT,
    tier             INT,
    level            TEXT,
    period_start     DATE,
    period_end       DATE,
    days_total       INT,
    days_elapsed     INT,
    days_remaining   INT,
    remaining_amount NUMERIC,
    safe_daily       NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT
            u.id           AS u_id,
            u.phone_number AS u_phone,
            b.id           AS b_id,
            c.name         AS c_name,
            c.emoji        AS c_emoji,
            b.amount       AS b_amount,
            b.period       AS b_period,
            COALESCE(s.spent, 0) AS s_spent,
            CASE b.period
                WHEN 'weekly' THEN DATE_TRUNC('week', CURRENT_DATE)::DATE
                WHEN 'yearly' THEN DATE_TRUNC('year', CURRENT_DATE)::DATE
                ELSE              DATE_TRUNC('month', CURRENT_DATE)::DATE
            END AS p_start,
            CASE b.period
                WHEN 'weekly' THEN (DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days' - INTERVAL '1 day')::DATE
                WHEN 'yearly' THEN (DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year' - INTERVAL '1 day')::DATE
                ELSE              (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::DATE
            END AS p_end
        FROM budgets b
        JOIN users u ON u.id = b.user_id
        JOIN categories c ON c.id = b.category_id
        LEFT JOIN LATERAL (
            SELECT SUM(t.amount) AS spent
            FROM v_reportable_transactions t
            WHERE t.user_id     = b.user_id
              AND t.category_id = b.category_id
              AND t.type        = 'expense'
              AND t.transaction_date >= CASE b.period
                  WHEN 'weekly' THEN DATE_TRUNC('week', CURRENT_DATE)::DATE
                  WHEN 'yearly' THEN DATE_TRUNC('year', CURRENT_DATE)::DATE
                  ELSE              DATE_TRUNC('month', CURRENT_DATE)::DATE
              END
        ) s ON TRUE
        WHERE b.is_active = TRUE AND u.is_active = TRUE
    ),
    enriched AS (
        SELECT
            b.*,
            (b.p_end - b.p_start + 1)::INT                                       AS days_total,
            GREATEST(1, LEAST(b.p_end, CURRENT_DATE) - b.p_start + 1)::INT       AS days_elapsed,
            GREATEST(0, b.p_end - CURRENT_DATE)::INT                             AS days_remaining,
            CASE WHEN b.b_amount > 0
                 THEN ROUND((b.s_spent / b.b_amount * 100)::NUMERIC, 0)::INT
                 ELSE 0 END                                                       AS real_pct,
            CASE WHEN b.b_amount > 0
                 THEN GREATEST(0::NUMERIC, b.b_amount - b.s_spent)
                 ELSE 0::NUMERIC END                                              AS remaining_amt
        FROM base b
    ),
    tiered AS (
        SELECT e.*,
            CASE
                WHEN e.real_pct >= 120 THEN 4
                WHEN e.real_pct >= 100 THEN 3
                WHEN e.real_pct >= 80  THEN 2
                WHEN e.real_pct >= 50
                     AND (e.days_elapsed::NUMERIC / NULLIF(e.days_total, 0)) * 100 < 40
                                       THEN 1
                ELSE 0
            END AS calc_tier
        FROM enriched e
    )
    SELECT
        t.u_id, t.u_phone, t.b_id, t.c_name, t.c_emoji,
        t.b_amount, t.b_period, t.s_spent, t.real_pct,
        t.calc_tier,
        CASE t.calc_tier
            WHEN 4 THEN 'over_critical'
            WHEN 3 THEN 'over_budget'
            WHEN 2 THEN 'near_budget'
            WHEN 1 THEN 'pacing_warn'
        END,
        t.p_start, t.p_end, t.days_total, t.days_elapsed, t.days_remaining,
        t.remaining_amt,
        CASE WHEN t.days_remaining > 0
             THEN ROUND((t.remaining_amt / t.days_remaining)::NUMERIC, 2)
             ELSE 0::NUMERIC END
    FROM tiered t
    WHERE t.calc_tier > 0
      AND NOT EXISTS (
          SELECT 1 FROM budget_alert_log bal
          WHERE bal.user_id = t.u_id
            AND bal.budget_id = t.b_id
            AND bal.notified_at > NOW() - INTERVAL '24 hours'
      )
      AND NOT EXISTS (
          SELECT 1 FROM budget_alert_log bal2
          WHERE bal2.user_id = t.u_id
            AND bal2.budget_id = t.b_id
            AND bal2.notified_at >= t.p_start::TIMESTAMPTZ
            AND bal2.level IN (
                SELECT v.tlevel FROM (VALUES
                    (1,'pacing_warn'),(2,'near_budget'),(3,'over_budget'),(4,'over_critical')
                ) v(tnum, tlevel) WHERE v.tnum >= t.calc_tier
            )
      );
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- A20.b Anomalies cron driver (atomic detect + dedup + conv_state)
-- =====================================================================
-- Para cada usuario activo: detecta anomalías de hoy NO notificadas,
-- elige la top (mayor multiplicador), inserta en anomaly_alert_log y
-- setea conv_state='awaiting_anomaly_confirm'. Devuelve una fila por usuario.
CREATE OR REPLACE FUNCTION claim_anomalies_for_cron()
RETURNS TABLE(
    user_id          UUID,
    phone            TEXT,
    transaction_id   UUID,
    category_name    TEXT,
    amount           NUMERIC,
    baseline         NUMERIC,
    multiplier       NUMERIC,
    description      TEXT,
    transaction_date DATE
) AS $$
DECLARE
    v_uid   UUID;
    v_phone TEXT;
    v_row   RECORD;
BEGIN
    FOR v_uid, v_phone IN
        SELECT u.id, u.phone_number FROM users u WHERE u.is_active = TRUE
    LOOP
        SELECT a.* INTO v_row
        FROM detect_anomalies(v_uid, CURRENT_DATE, 60) a
        WHERE a.kind = 'transaction'
          AND a.transaction_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM anomaly_alert_log al
              WHERE al.user_id = v_uid
                AND al.kind = 'transaction'
                AND al.ref_id = a.transaction_id::text
          )
        ORDER BY a.multiplier DESC NULLS LAST, a.amount DESC
        LIMIT 1;

        IF v_row.transaction_id IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO anomaly_alert_log (user_id, kind, ref_id)
        VALUES (v_uid, 'transaction', v_row.transaction_id::text)
        ON CONFLICT (user_id, kind, ref_id) DO NOTHING;

        PERFORM set_conv_state(
            v_uid,
            'awaiting_anomaly_confirm',
            jsonb_build_object('transaction_id', v_row.transaction_id),
            900
        );

        user_id          := v_uid;
        phone            := v_phone;
        transaction_id   := v_row.transaction_id;
        category_name    := v_row.category_name;
        amount           := v_row.amount;
        baseline         := v_row.baseline;
        multiplier       := v_row.multiplier;
        description      := v_row.description;
        transaction_date := v_row.transaction_date;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- =====================================================================
-- A19.b Subscription notice driver (cron mensual)
-- =====================================================================
-- Devuelve suscripciones detectadas que NO fueron notificadas (subscription_notice_log),
-- y las marca como notificadas. Filtra por confidence >= 0.5.
CREATE OR REPLACE FUNCTION claim_new_subscriptions_for_cron()
RETURNS TABLE(
    user_id        UUID,
    phone          TEXT,
    items          JSONB,
    monthly_total  NUMERIC,
    new_count      INT
) AS $$
DECLARE
    v_uid   UUID;
    v_phone TEXT;
    v_items JSONB;
    v_total NUMERIC;
    v_count INT;
BEGIN
    FOR v_uid, v_phone IN
        SELECT u.id, u.phone_number FROM users u WHERE u.is_active = TRUE
    LOOP
        WITH subs AS (
            SELECT s.merchant_key, s.sample_description, s.category_name,
                   s.avg_amount, s.cadence_days, s.cadence_label,
                   s.next_estimated_date, s.confidence
            FROM detect_subscriptions(v_uid, 90) s
            WHERE s.confidence >= 0.5
              AND NOT EXISTS (
                  SELECT 1 FROM subscription_notice_log snl
                  WHERE snl.user_id = v_uid
                    AND snl.merchant_key = s.merchant_key
                    AND snl.cadence_days = s.cadence_days
              )
        ),
        ins AS (
            INSERT INTO subscription_notice_log (user_id, merchant_key, cadence_days)
            SELECT v_uid, subs.merchant_key, subs.cadence_days FROM subs
            ON CONFLICT (user_id, merchant_key, cadence_days) DO NOTHING
            RETURNING 1
        )
        SELECT
            COALESCE(jsonb_agg(jsonb_build_object(
                'description', subs.sample_description,
                'category',    subs.category_name,
                'avg_amount',  subs.avg_amount,
                'cadence',     subs.cadence_label,
                'next_date',   subs.next_estimated_date
            )), '[]'::jsonb),
            COALESCE(SUM(subs.avg_amount * (30::NUMERIC / NULLIF(subs.cadence_days, 0))), 0),
            COUNT(*)::INT
        INTO v_items, v_total, v_count
        FROM subs;

        IF v_count > 0 THEN
            user_id       := v_uid;
            phone         := v_phone;
            items         := v_items;
            monthly_total := ROUND(v_total, 2);
            new_count     := v_count;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- =====================================================================
-- A22. Monthly digest (LLM) — snapshot + dedup log
-- =====================================================================
CREATE TABLE IF NOT EXISTS monthly_digest_log (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_key  TEXT NOT NULL,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, period_key)
);

-- Snapshot consolidado del mes objetivo (default: mes anterior).
-- Devuelve un JSONB con totales, breakdown, top tx, suscripciones, presupuestos y cashflow.
-- Si has_income=FALSE, cashflow viene NULL (digest se genera igual sin sección de saldo).
CREATE OR REPLACE FUNCTION monthly_digest_snapshot(
    p_user_id UUID,
    p_target_month DATE DEFAULT (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month')::DATE
)
RETURNS JSONB AS $$
DECLARE
    v_month_start DATE := DATE_TRUNC('month', p_target_month)::DATE;
    v_month_end   DATE := (DATE_TRUNC('month', p_target_month) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_prev_start  DATE := (v_month_start - INTERVAL '1 month')::DATE;
    v_prev_end    DATE := (v_month_start - INTERVAL '1 day')::DATE;
    v_has_income  BOOLEAN;
    v_result      JSONB;
BEGIN
    v_has_income := user_has_income(p_user_id);

    SELECT jsonb_build_object(
        'period_key',  TO_CHAR(v_month_start, 'YYYY-MM'),
        'month_label', TO_CHAR(v_month_start, 'TMMonth YYYY'),
        'has_income',  v_has_income,
        'cashflow', CASE WHEN v_has_income THEN (
            SELECT jsonb_build_object(
                'income',          cf.income,
                'expenses',        cf.expenses,
                'net',             cf.net,
                'daily_burn_rate', cf.daily_burn_rate
            )
            FROM get_cashflow(p_user_id, v_month_start, v_month_end) cf
        ) ELSE NULL END,
        'totals', (
            SELECT jsonb_build_object(
                'expenses_this', COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.transaction_date BETWEEN v_month_start AND v_month_end), 0),
                'expenses_prev', COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.transaction_date BETWEEN v_prev_start  AND v_prev_end),  0),
                'count_this',    COUNT(*) FILTER (WHERE t.type='expense' AND t.transaction_date BETWEEN v_month_start AND v_month_end),
                'count_prev',    COUNT(*) FILTER (WHERE t.type='expense' AND t.transaction_date BETWEEN v_prev_start  AND v_prev_end)
            )
            FROM v_reportable_transactions t
            WHERE t.user_id = p_user_id
              AND t.transaction_date BETWEEN v_prev_start AND v_month_end
        ),
        'by_category', (
            SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
            FROM (
                SELECT c.name AS category, c.emoji,
                       COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date BETWEEN v_month_start AND v_month_end), 0) AS this_month,
                       COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date BETWEEN v_prev_start  AND v_prev_end),  0) AS prev_month
                FROM v_reportable_transactions t
                LEFT JOIN categories c ON c.id = t.category_id
                WHERE t.user_id = p_user_id AND t.type = 'expense'
                  AND t.transaction_date BETWEEN v_prev_start AND v_month_end
                GROUP BY c.name, c.emoji
                HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date BETWEEN v_month_start AND v_month_end), 0) > 0
                    OR COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date BETWEEN v_prev_start  AND v_prev_end),  0) > 0
                ORDER BY this_month DESC
                LIMIT 8
            ) x
        ),
        'top_transactions', (
            SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
            FROM (
                SELECT t.amount, COALESCE(t.description,'') AS description, c.name AS category, t.transaction_date
                FROM v_reportable_transactions t
                LEFT JOIN categories c ON c.id = t.category_id
                WHERE t.user_id = p_user_id AND t.type = 'expense'
                  AND t.transaction_date BETWEEN v_month_start AND v_month_end
                ORDER BY t.amount DESC
                LIMIT 5
            ) x
        ),
        'subscriptions', (
            SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
            FROM (
                SELECT sample_description AS description, category_name, avg_amount, cadence_label
                FROM detect_subscriptions(p_user_id, 90)
                ORDER BY avg_amount DESC
                LIMIT 6
            ) x
        ),
        'budget_status', (
            SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
            FROM (
                SELECT c.name AS category, b.amount AS budget, COALESCE(s.spent, 0) AS spent,
                       CASE WHEN b.amount > 0 THEN ROUND((COALESCE(s.spent,0) / b.amount * 100)::NUMERIC, 0) ELSE 0 END AS pct
                FROM budgets b
                JOIN categories c ON c.id = b.category_id
                LEFT JOIN LATERAL (
                    SELECT SUM(t.amount) AS spent
                    FROM v_reportable_transactions t
                    WHERE t.user_id = b.user_id AND t.category_id = b.category_id AND t.type='expense'
                      AND t.transaction_date BETWEEN v_month_start AND v_month_end
                ) s ON TRUE
                WHERE b.user_id = p_user_id AND b.is_active = TRUE AND b.period = 'monthly'
            ) x
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- A22.b Monthly digest cron driver (atomic claim + dedup)
-- =====================================================================
-- Para cada usuario activo: si no recibió digest del mes anterior y tuvo
-- actividad ese mes, calcula el snapshot, lo marca como entregado y lo
-- devuelve al cron para que mande el mensaje generado por LLM.
CREATE OR REPLACE FUNCTION claim_monthly_digests_for_cron()
RETURNS TABLE(
    user_id     UUID,
    phone       TEXT,
    period_key  TEXT,
    snapshot    JSONB
) AS $$
DECLARE
    v_uid    UUID;
    v_phone  TEXT;
    v_target DATE := (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month')::DATE;
    v_pkey   TEXT := TO_CHAR(v_target, 'YYYY-MM');
    v_snap   JSONB;
BEGIN
    FOR v_uid, v_phone IN
        SELECT u.id, u.phone_number FROM users u WHERE u.is_active = TRUE
    LOOP
        IF EXISTS (
            SELECT 1 FROM monthly_digest_log mdl
            WHERE mdl.user_id = v_uid AND mdl.period_key = v_pkey
        ) THEN
            CONTINUE;
        END IF;

        v_snap := monthly_digest_snapshot(v_uid, v_target);

        IF COALESCE((v_snap->'totals'->>'count_this')::INT, 0) = 0 THEN
            CONTINUE;
        END IF;

        INSERT INTO monthly_digest_log (user_id, period_key)
        VALUES (v_uid, v_pkey)
        ON CONFLICT (user_id, period_key) DO NOTHING;

        user_id    := v_uid;
        phone      := v_phone;
        period_key := v_pkey;
        snapshot   := v_snap;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- =====================================================================
-- Migration 002: CRUD completos de recurrentes, grupos, presupuestos,
-- tags y settings de usuario. Todo idempotente y siempre filtrado por user_id.
-- =====================================================================

-- ---------- B1. list_recurring ----------
-- Devuelve todas las recurrentes (activas o no) del usuario con su contexto.
CREATE OR REPLACE FUNCTION list_recurring(
    p_user_id UUID,
    p_active_only BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(
    id UUID,
    type TEXT,
    amount NUMERIC,
    description TEXT,
    frequency TEXT,
    next_occurrence DATE,
    last_occurrence DATE,
    end_date DATE,
    is_active BOOLEAN,
    category_id UUID,
    category_name TEXT,
    category_emoji TEXT,
    payment_method_id UUID,
    payment_method_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT r.id, r.type, r.amount, r.description, r.frequency,
           r.next_occurrence, r.last_occurrence, r.end_date, r.is_active,
           r.category_id, c.name, c.emoji,
           r.payment_method_id, pm.name
    FROM recurring_transactions r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
    WHERE r.user_id = p_user_id
      AND (NOT p_active_only OR r.is_active)
    ORDER BY r.is_active DESC, r.next_occurrence ASC NULLS LAST, r.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- B2. find_recurring_by_hint ----------
-- Resuelve una recurrente por nombre/descripción. Devuelve la más relevante.
CREATE OR REPLACE FUNCTION find_recurring_by_hint(
    p_user_id UUID,
    p_hint TEXT
)
RETURNS TABLE(id UUID, description TEXT, amount NUMERIC, frequency TEXT, is_active BOOLEAN) AS $$
BEGIN
    IF COALESCE(p_hint, '') = '' THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT r.id, r.description, r.amount, r.frequency, r.is_active
    FROM recurring_transactions r
    WHERE r.user_id = p_user_id
      AND (normalize_text(r.description) = normalize_text(p_hint)
           OR normalize_text(r.description) ILIKE '%' || normalize_text(p_hint) || '%'
           OR similarity(normalize_text(r.description), normalize_text(p_hint)) >= 0.4)
    ORDER BY (normalize_text(r.description) = normalize_text(p_hint)) DESC,
             similarity(normalize_text(r.description), normalize_text(p_hint)) DESC,
             r.is_active DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- B3. update_recurring ----------
-- Edita una recurrente existente. Acepta hints en lugar de UUIDs.
CREATE OR REPLACE FUNCTION update_recurring(
    p_user_id UUID,
    p_recurring_id UUID,
    p_new_amount NUMERIC DEFAULT NULL,
    p_new_description TEXT DEFAULT NULL,
    p_new_frequency TEXT DEFAULT NULL,
    p_new_category_hint TEXT DEFAULT NULL,
    p_new_next_occurrence DATE DEFAULT NULL,
    p_new_end_date DATE DEFAULT NULL,
    p_create_category_if_missing BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    id UUID, amount NUMERIC, description TEXT, frequency TEXT,
    next_occurrence DATE, end_date DATE, is_active BOOLEAN,
    category_name TEXT
) AS $$
DECLARE
    v_resolved_cat_id UUID := NULL;
    v_type TEXT;
BEGIN
    -- Validar frequency si vino
    IF p_new_frequency IS NOT NULL AND p_new_frequency NOT IN ('daily','weekly','monthly','yearly') THEN
        RAISE EXCEPTION 'frecuencia inválida "%"; usá daily, weekly, monthly o yearly', p_new_frequency;
    END IF;

    -- Resolver categoría por hint si vino
    IF COALESCE(p_new_category_hint, '') <> '' THEN
        SELECT r.type INTO v_type FROM recurring_transactions r
        WHERE r.id = p_recurring_id AND r.user_id = p_user_id;

        IF p_create_category_if_missing THEN
            SELECT category_id INTO v_resolved_cat_id
            FROM resolve_or_create_category(p_user_id, p_new_category_hint, COALESCE(v_type, 'expense'));
        ELSE
            SELECT category_id INTO v_resolved_cat_id
            FROM find_best_category(p_user_id, p_new_category_hint, COALESCE(v_type, 'expense'));
        END IF;
    END IF;

    RETURN QUERY
    UPDATE recurring_transactions r
    SET amount = COALESCE(p_new_amount, r.amount),
        description = COALESCE(NULLIF(p_new_description,''), r.description),
        frequency = COALESCE(NULLIF(p_new_frequency,''), r.frequency),
        category_id = COALESCE(v_resolved_cat_id, r.category_id),
        next_occurrence = COALESCE(p_new_next_occurrence, r.next_occurrence),
        end_date = COALESCE(p_new_end_date, r.end_date),
        updated_at = NOW()
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id
    RETURNING r.id, r.amount, r.description, r.frequency, r.next_occurrence,
              r.end_date, r.is_active,
              (SELECT c.name FROM categories c WHERE c.id = r.category_id);
END;
$$ LANGUAGE plpgsql;

-- ---------- B4. pause_recurring / resume_recurring / cancel_recurring ----------
-- pause: is_active=FALSE pero NO setea end_date (puede reanudarse)
-- cancel: is_active=FALSE Y end_date=hoy (cierre definitivo)
CREATE OR REPLACE FUNCTION pause_recurring(p_user_id UUID, p_recurring_id UUID)
RETURNS TABLE(id UUID, description TEXT, was_active BOOLEAN, paused BOOLEAN) AS $$
DECLARE v_prev BOOLEAN;
BEGIN
    SELECT r.is_active INTO v_prev FROM recurring_transactions r
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
    IF v_prev IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, NULL::TEXT, FALSE, FALSE;
        RETURN;
    END IF;
    UPDATE recurring_transactions
    SET is_active = FALSE, updated_at = NOW()
    WHERE recurring_transactions.id = p_recurring_id
      AND recurring_transactions.user_id = p_user_id;
    RETURN QUERY
    SELECT r.id, r.description, v_prev, TRUE
    FROM recurring_transactions r
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resume_recurring(p_user_id UUID, p_recurring_id UUID)
RETURNS TABLE(id UUID, description TEXT, resumed BOOLEAN) AS $$
DECLARE v_exists BOOLEAN;
BEGIN
    SELECT TRUE INTO v_exists FROM recurring_transactions r
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
    IF v_exists IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, NULL::TEXT, FALSE;
        RETURN;
    END IF;
    UPDATE recurring_transactions
    SET is_active = TRUE,
        end_date = NULL,
        next_occurrence = CASE
            WHEN next_occurrence < CURRENT_DATE THEN CURRENT_DATE
            ELSE next_occurrence
        END,
        updated_at = NOW()
    WHERE recurring_transactions.id = p_recurring_id
      AND recurring_transactions.user_id = p_user_id;
    RETURN QUERY
    SELECT r.id, r.description, TRUE FROM recurring_transactions r
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cancel_recurring(p_user_id UUID, p_recurring_id UUID)
RETURNS TABLE(id UUID, description TEXT, cancelled BOOLEAN) AS $$
BEGIN
    UPDATE recurring_transactions r
    SET is_active = FALSE,
        end_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, NULL::TEXT, FALSE;
        RETURN;
    END IF;
    RETURN QUERY
    SELECT r.id, r.description, TRUE FROM recurring_transactions r
    WHERE r.id = p_recurring_id AND r.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- B5. update_group ----------
-- Edita campos del grupo (nombre, kind, fechas, emoji). Idempotente: no toca lo que no le pasen.
CREATE OR REPLACE FUNCTION update_group(
    p_user_id UUID,
    p_name TEXT,                  -- nombre actual del grupo (lookup)
    p_new_name TEXT DEFAULT NULL,
    p_new_kind TEXT DEFAULT NULL,
    p_new_emoji TEXT DEFAULT NULL,
    p_new_starts_at DATE DEFAULT NULL,
    p_new_ends_at DATE DEFAULT NULL
)
RETURNS TABLE(
    id UUID, name TEXT, kind TEXT, emoji TEXT,
    starts_at DATE, ends_at DATE, is_active BOOLEAN
) AS $$
DECLARE
    v_id UUID;
    v_new_norm TEXT;
    v_conflict UUID;
BEGIN
    SELECT g.id INTO v_id FROM expense_groups g
    WHERE g.user_id = p_user_id
      AND (g.normalized_name = normalize_text(p_name)
           OR similarity(g.normalized_name, normalize_text(p_name)) >= 0.5)
    ORDER BY (g.normalized_name = normalize_text(p_name)) DESC,
             similarity(g.normalized_name, normalize_text(p_name)) DESC,
             g.is_active DESC
    LIMIT 1;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'No encontré el grupo "%"', p_name;
    END IF;

    -- Validar nuevo nombre si vino
    IF COALESCE(p_new_name, '') <> '' THEN
        v_new_norm := normalize_text(p_new_name);
        SELECT g.id INTO v_conflict FROM expense_groups g
        WHERE g.user_id = p_user_id AND g.normalized_name = v_new_norm AND g.id <> v_id
        LIMIT 1;
        IF v_conflict IS NOT NULL THEN
            RAISE EXCEPTION 'Ya tenés un grupo con el nombre "%"', p_new_name;
        END IF;
    END IF;

    -- Validar kind si vino
    IF p_new_kind IS NOT NULL AND p_new_kind NOT IN ('trip','event','emergency','project','other') THEN
        RAISE EXCEPTION 'kind inválido "%"; usá trip, event, emergency, project u other', p_new_kind;
    END IF;

    UPDATE expense_groups g
    SET name = COALESCE(NULLIF(p_new_name,''), g.name),
        kind = COALESCE(NULLIF(p_new_kind,''), g.kind),
        emoji = COALESCE(NULLIF(p_new_emoji,''), g.emoji),
        starts_at = COALESCE(p_new_starts_at, g.starts_at),
        ends_at = COALESCE(p_new_ends_at, g.ends_at),
        updated_at = NOW()
    WHERE g.id = v_id;

    RETURN QUERY
    SELECT g.id, g.name, g.kind, g.emoji, g.starts_at, g.ends_at, g.is_active
    FROM expense_groups g WHERE g.id = v_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- B6. rename_group (alias semántico de update_group) ----------
CREATE OR REPLACE FUNCTION rename_group(
    p_user_id UUID, p_old_name TEXT, p_new_name TEXT
)
RETURNS TABLE(id UUID, old_name TEXT, new_name TEXT, renamed BOOLEAN) AS $$
DECLARE v_old TEXT; r RECORD;
BEGIN
    SELECT name INTO v_old FROM expense_groups
    WHERE user_id = p_user_id
      AND (normalized_name = normalize_text(p_old_name)
           OR similarity(normalized_name, normalize_text(p_old_name)) >= 0.5)
    ORDER BY (normalized_name = normalize_text(p_old_name)) DESC
    LIMIT 1;
    IF v_old IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_old_name, p_new_name, FALSE;
        RETURN;
    END IF;
    SELECT * INTO r FROM update_group(p_user_id, v_old, p_new_name);
    RETURN QUERY SELECT r.id, v_old, r.name, TRUE;
END;
$$ LANGUAGE plpgsql;

-- ---------- B7. close_group ----------
-- Marca un grupo como cerrado: ends_at=hoy, is_active=FALSE.
-- No borra nada — las transacciones siguen ahí, solo deja de aceptar nuevas asociaciones.
CREATE OR REPLACE FUNCTION close_group(p_user_id UUID, p_name TEXT)
RETURNS TABLE(id UUID, name TEXT, ends_at DATE, closed BOOLEAN) AS $$
BEGIN
    UPDATE expense_groups g
    SET is_active = FALSE,
        ends_at = COALESCE(g.ends_at, CURRENT_DATE),
        updated_at = NOW()
    WHERE g.user_id = p_user_id
      AND (g.normalized_name = normalize_text(p_name)
           OR similarity(g.normalized_name, normalize_text(p_name)) >= 0.5);
    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, p_name, NULL::DATE, FALSE;
        RETURN;
    END IF;
    RETURN QUERY
    SELECT g.id, g.name, g.ends_at, TRUE
    FROM expense_groups g
    WHERE g.user_id = p_user_id
      AND (g.normalized_name = normalize_text(p_name)
           OR similarity(g.normalized_name, normalize_text(p_name)) >= 0.5)
    ORDER BY (g.normalized_name = normalize_text(p_name)) DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ---------- B8. delete_group ----------
-- Borra un grupo. Si tiene transacciones, requiere reasignar (reassign_to_name) o
-- pasar p_unassign=TRUE para dejarlas sin grupo (group_id=NULL).
CREATE OR REPLACE FUNCTION delete_group(
    p_user_id UUID,
    p_name TEXT,
    p_reassign_to_name TEXT DEFAULT NULL,
    p_unassign BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    id UUID, name TEXT, deleted BOOLEAN,
    moved_transactions INT, reassigned_to TEXT
) AS $$
DECLARE
    v_id UUID; v_name TEXT;
    v_target UUID; v_target_name TEXT;
    v_moved INT;
BEGIN
    SELECT g.id, g.name INTO v_id, v_name FROM expense_groups g
    WHERE g.user_id = p_user_id
      AND (g.normalized_name = normalize_text(p_name)
           OR similarity(g.normalized_name, normalize_text(p_name)) >= 0.5)
    ORDER BY (g.normalized_name = normalize_text(p_name)) DESC
    LIMIT 1;
    IF v_id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_name, FALSE, 0, NULL::TEXT;
        RETURN;
    END IF;

    -- Contar tx vinculadas
    SELECT COUNT(*)::INT INTO v_moved
    FROM transactions WHERE user_id = p_user_id AND group_id = v_id;

    IF v_moved > 0 THEN
        IF COALESCE(p_reassign_to_name, '') <> '' THEN
            SELECT g.id, g.name INTO v_target, v_target_name FROM expense_groups g
            WHERE g.user_id = p_user_id AND g.is_active
              AND g.normalized_name = normalize_text(p_reassign_to_name);
            IF v_target IS NULL THEN
                RAISE EXCEPTION 'El grupo destino "%" no existe', p_reassign_to_name;
            END IF;
            UPDATE transactions SET group_id = v_target, updated_at = NOW()
            WHERE user_id = p_user_id AND group_id = v_id;
        ELSIF p_unassign THEN
            UPDATE transactions SET group_id = NULL, updated_at = NOW()
            WHERE user_id = p_user_id AND group_id = v_id;
        ELSE
            RAISE EXCEPTION 'El grupo "%" tiene % transacciones. Pasá reassign_to_name o unassign=true.', v_name, v_moved;
        END IF;
    END IF;

    DELETE FROM expense_groups eg WHERE eg.id = v_id;
    RETURN QUERY SELECT v_id, v_name, TRUE, v_moved, v_target_name;
END;
$$ LANGUAGE plpgsql;

-- ---------- B9. delete_budget / pause_budget / resume_budget ----------
-- delete_budget: hard-delete del row (no hay tx asociadas, es solo un límite).
-- pause/resume: toggle is_active sin perder el monto.
CREATE OR REPLACE FUNCTION delete_budget(
    p_user_id UUID,
    p_category_hint TEXT,
    p_period TEXT DEFAULT NULL
)
RETURNS TABLE(deleted_count INT, category_name TEXT) AS $$
DECLARE v_cat_id UUID; v_cat_name TEXT; v_count INT;
BEGIN
    SELECT fbc.category_id, fbc.category_name INTO v_cat_id, v_cat_name
    FROM find_best_category(p_user_id, p_category_hint, 'expense') fbc;
    IF v_cat_id IS NULL THEN
        RETURN QUERY SELECT 0, p_category_hint;
        RETURN;
    END IF;
    DELETE FROM budgets b
    WHERE b.user_id = p_user_id
      AND b.category_id = v_cat_id
      AND (p_period IS NULL OR b.period = p_period);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT v_count, v_cat_name;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pause_budget(
    p_user_id UUID, p_category_hint TEXT, p_period TEXT DEFAULT NULL
)
RETURNS TABLE(paused_count INT, category_name TEXT) AS $$
DECLARE v_cat_id UUID; v_cat_name TEXT; v_count INT;
BEGIN
    SELECT fbc.category_id, fbc.category_name INTO v_cat_id, v_cat_name
    FROM find_best_category(p_user_id, p_category_hint, 'expense') fbc;
    IF v_cat_id IS NULL THEN
        RETURN QUERY SELECT 0, p_category_hint;
        RETURN;
    END IF;
    UPDATE budgets b
    SET is_active = FALSE, updated_at = NOW()
    WHERE b.user_id = p_user_id
      AND b.category_id = v_cat_id
      AND b.is_active
      AND (p_period IS NULL OR b.period = p_period);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT v_count, v_cat_name;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resume_budget(
    p_user_id UUID, p_category_hint TEXT, p_period TEXT DEFAULT NULL
)
RETURNS TABLE(resumed_count INT, category_name TEXT) AS $$
DECLARE v_cat_id UUID; v_cat_name TEXT; v_count INT;
BEGIN
    SELECT fbc.category_id, fbc.category_name INTO v_cat_id, v_cat_name
    FROM find_best_category(p_user_id, p_category_hint, 'expense') fbc;
    IF v_cat_id IS NULL THEN
        RETURN QUERY SELECT 0, p_category_hint;
        RETURN;
    END IF;
    UPDATE budgets b
    SET is_active = TRUE, updated_at = NOW()
    WHERE b.user_id = p_user_id
      AND b.category_id = v_cat_id
      AND NOT b.is_active
      AND (p_period IS NULL OR b.period = p_period);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT v_count, v_cat_name;
END;
$$ LANGUAGE plpgsql;

-- ---------- B10. Tags CRUD ----------
-- create_tag: idempotente. Si ya existe (exact o fuzzy) la devuelve.
CREATE OR REPLACE FUNCTION create_tag(
    p_user_id UUID, p_name TEXT, p_color TEXT DEFAULT NULL
)
RETURNS TABLE(tag_id UUID, tag_name TEXT, was_created BOOLEAN) AS $$
DECLARE v_id UUID; v_name TEXT; v_norm TEXT := normalize_text(p_name);
BEGIN
    IF COALESCE(v_norm, '') = '' THEN
        RAISE EXCEPTION 'el nombre del tag no puede estar vacío';
    END IF;
    SELECT id, name INTO v_id, v_name FROM tags
    WHERE user_id = p_user_id AND normalized_name = v_norm
    LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, v_name, FALSE;
        RETURN;
    END IF;
    INSERT INTO tags (user_id, name, normalized_name, color)
    VALUES (p_user_id, INITCAP(p_name), v_norm, COALESCE(p_color, '#888888'))
    RETURNING id, name INTO v_id, v_name;
    RETURN QUERY SELECT v_id, v_name, TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rename_tag(
    p_user_id UUID, p_old_name TEXT, p_new_name TEXT
)
RETURNS TABLE(tag_id UUID, old_name TEXT, new_name TEXT, renamed BOOLEAN) AS $$
DECLARE v_id UUID; v_old TEXT; v_new_norm TEXT := normalize_text(p_new_name);
BEGIN
    SELECT id, name INTO v_id, v_old FROM tags
    WHERE user_id = p_user_id
      AND (normalized_name = normalize_text(p_old_name)
           OR similarity(normalized_name, normalize_text(p_old_name)) >= 0.5)
    ORDER BY (normalized_name = normalize_text(p_old_name)) DESC
    LIMIT 1;
    IF v_id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_old_name, p_new_name, FALSE;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM tags WHERE user_id = p_user_id AND normalized_name = v_new_norm AND id <> v_id) THEN
        RAISE EXCEPTION 'Ya tenés un tag llamado "%"', p_new_name;
    END IF;
    UPDATE tags SET name = INITCAP(p_new_name), normalized_name = v_new_norm
    WHERE id = v_id;
    RETURN QUERY SELECT v_id, v_old, INITCAP(p_new_name), TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_tag(p_user_id UUID, p_name TEXT)
RETURNS TABLE(tag_id UUID, tag_name TEXT, untagged_transactions INT, deleted BOOLEAN) AS $$
DECLARE v_id UUID; v_name TEXT; v_count INT;
BEGIN
    SELECT t.id, t.name INTO v_id, v_name FROM tags t
    WHERE t.user_id = p_user_id
      AND (t.normalized_name = normalize_text(p_name)
           OR similarity(t.normalized_name, normalize_text(p_name)) >= 0.5)
    ORDER BY (t.normalized_name = normalize_text(p_name)) DESC
    LIMIT 1;
    IF v_id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, p_name, 0, FALSE;
        RETURN;
    END IF;
    SELECT COUNT(*)::INT INTO v_count
    FROM transaction_tags tt WHERE tt.tag_id = v_id;
    DELETE FROM tags t WHERE t.id = v_id;
    -- transaction_tags se borra por CASCADE
    RETURN QUERY SELECT v_id, v_name, v_count, TRUE;
END;
$$ LANGUAGE plpgsql;

-- list_tags: incluye conteo y total gastado, para que el agente pueda mostrar resúmenes útiles.
CREATE OR REPLACE FUNCTION list_tags(p_user_id UUID)
RETURNS TABLE(
    id UUID, name TEXT, color TEXT,
    tx_count BIGINT, total_amount NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.name, t.color,
           COUNT(tt.transaction_id)::BIGINT AS tx_count,
           COALESCE(SUM(tx.amount), 0)::NUMERIC AS total_amount
    FROM tags t
    LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
    LEFT JOIN transactions tx ON tx.id = tt.transaction_id AND tx.user_id = p_user_id
    WHERE t.user_id = p_user_id
    GROUP BY t.id, t.name, t.color
    ORDER BY tx_count DESC, t.name;
END;
$$ LANGUAGE plpgsql STABLE;

-- tag_transactions: aplica un tag a un set de transacciones (idempotente vía ON CONFLICT).
-- Si create_if_missing=TRUE, crea el tag si no existe.
CREATE OR REPLACE FUNCTION tag_transactions(
    p_user_id UUID,
    p_tag_name TEXT,
    p_tx_ids UUID[],
    p_create_if_missing BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(tag_id UUID, tag_name TEXT, tagged_count INT, was_created BOOLEAN) AS $$
DECLARE v_id UUID; v_name TEXT; v_created BOOLEAN := FALSE; v_count INT;
BEGIN
    SELECT t.id, t.name INTO v_id, v_name FROM tags t
    WHERE t.user_id = p_user_id AND t.normalized_name = normalize_text(p_tag_name)
    LIMIT 1;
    IF v_id IS NULL THEN
        IF NOT p_create_if_missing THEN
            RAISE EXCEPTION 'No existe el tag "%". Pasá create_if_missing=true o creálo primero.', p_tag_name;
        END IF;
        SELECT ct.tag_id, ct.tag_name INTO v_id, v_name FROM create_tag(p_user_id, p_tag_name) ct;
        v_created := TRUE;
    END IF;

    -- Insertar relaciones, validando que las tx pertenezcan al usuario
    WITH ins AS (
        INSERT INTO transaction_tags (transaction_id, tag_id)
        SELECT t.id, v_id FROM transactions t
        WHERE t.user_id = p_user_id AND t.id = ANY(p_tx_ids)
        ON CONFLICT DO NOTHING
        RETURNING transaction_id
    )
    SELECT COUNT(*)::INT INTO v_count FROM ins;

    RETURN QUERY SELECT v_id, v_name, v_count, v_created;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION untag_transactions(
    p_user_id UUID, p_tag_name TEXT, p_tx_ids UUID[]
)
RETURNS TABLE(untagged_count INT) AS $$
DECLARE v_id UUID; v_count INT;
BEGIN
    SELECT id INTO v_id FROM tags
    WHERE user_id = p_user_id AND normalized_name = normalize_text(p_tag_name)
    LIMIT 1;
    IF v_id IS NULL THEN
        RETURN QUERY SELECT 0;
        RETURN;
    END IF;
    WITH del AS (
        DELETE FROM transaction_tags tt
        USING transactions t
        WHERE tt.tag_id = v_id
          AND tt.transaction_id = t.id
          AND t.user_id = p_user_id
          AND tt.transaction_id = ANY(p_tx_ids)
        RETURNING tt.transaction_id
    )
    SELECT COUNT(*)::INT INTO v_count FROM del;
    RETURN QUERY SELECT v_count;
END;
$$ LANGUAGE plpgsql;

-- suggest_tags: sugiere tags para una descripción / monto basándose en
-- transacciones similares ya tageadas por el usuario. Útil para que el LLM
-- ofrezca tags al loggear sin pedirle al usuario que los recuerde de memoria.
CREATE OR REPLACE FUNCTION suggest_tags(
    p_user_id UUID,
    p_description TEXT,
    p_amount NUMERIC DEFAULT NULL,
    p_limit INT DEFAULT 5
)
RETURNS TABLE(tag_id UUID, tag_name TEXT, score REAL, sample_uses INT) AS $$
DECLARE v_norm TEXT := normalize_text(COALESCE(p_description,''));
BEGIN
    IF v_norm = '' THEN RETURN; END IF;
    RETURN QUERY
    SELECT t.id, t.name,
           AVG(similarity(normalize_text(tx.description), v_norm))::REAL AS score,
           COUNT(*)::INT AS sample_uses
    FROM tags t
    JOIN transaction_tags tt ON tt.tag_id = t.id
    JOIN transactions tx ON tx.id = tt.transaction_id AND tx.user_id = p_user_id
    WHERE t.user_id = p_user_id
      AND similarity(normalize_text(tx.description), v_norm) >= 0.2
    GROUP BY t.id, t.name
    HAVING AVG(similarity(normalize_text(tx.description), v_norm)) >= 0.25
    ORDER BY AVG(similarity(normalize_text(tx.description), v_norm)) DESC,
             COUNT(*) DESC
    LIMIT GREATEST(p_limit, 1);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- B11. User settings ----------
-- get_user_settings: devuelve preferencias actuales para que el agente las muestre.
CREATE OR REPLACE FUNCTION get_user_settings(p_user_id UUID)
RETURNS TABLE(
    name TEXT,
    phone_number TEXT,
    preferred_currency TEXT,
    daily_summary_enabled BOOLEAN,
    daily_summary_hour INT,
    weekly_summary_enabled BOOLEAN,
    onboarded BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT u.name, u.phone_number, u.preferred_currency,
           u.daily_summary_enabled, u.daily_summary_hour, u.weekly_summary_enabled,
           u.onboarded
    FROM users u WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- update_user_settings: edita las preferencias. Solo modifica los campos que vienen NOT NULL.
CREATE OR REPLACE FUNCTION update_user_settings(
    p_user_id UUID,
    p_name TEXT DEFAULT NULL,
    p_preferred_currency TEXT DEFAULT NULL,
    p_daily_summary_enabled BOOLEAN DEFAULT NULL,
    p_daily_summary_hour INT DEFAULT NULL,
    p_weekly_summary_enabled BOOLEAN DEFAULT NULL
)
RETURNS TABLE(
    name TEXT,
    preferred_currency TEXT,
    daily_summary_enabled BOOLEAN,
    daily_summary_hour INT,
    weekly_summary_enabled BOOLEAN
) AS $$
BEGIN
    IF p_daily_summary_hour IS NOT NULL AND (p_daily_summary_hour < 0 OR p_daily_summary_hour > 23) THEN
        RAISE EXCEPTION 'daily_summary_hour debe estar entre 0 y 23, recibí %', p_daily_summary_hour;
    END IF;
    UPDATE users u
    SET name = COALESCE(NULLIF(p_name,''), u.name),
        preferred_currency = COALESCE(NULLIF(p_preferred_currency,''), u.preferred_currency),
        daily_summary_enabled = COALESCE(p_daily_summary_enabled, u.daily_summary_enabled),
        daily_summary_hour = COALESCE(p_daily_summary_hour, u.daily_summary_hour),
        weekly_summary_enabled = COALESCE(p_weekly_summary_enabled, u.weekly_summary_enabled),
        updated_at = NOW()
    WHERE u.id = p_user_id;
    RETURN QUERY
    SELECT u.name, u.preferred_currency,
           u.daily_summary_enabled, u.daily_summary_hour, u.weekly_summary_enabled
    FROM users u WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- compute_financial_advice — asesor financiero con 5 modos
-- =====================================================================
-- Calcula promedios de ingresos/gastos a partir de los últimos
-- p_lookback_months meses CALENDARIO COMPLETOS (excluye el mes actual,
-- que está incompleto por definición y rompería el promedio).
-- Si no hay meses históricos con data, cae al mes actual proporcional.
--
-- Modos:
--   'time_to_goal'      → cuántos meses para juntar p_goal_amount.
--   'affordability'     → ¿el ahorro mensual cubre p_goal_amount de un saque?
--   'savings_capacity'  → ingresos/gastos/ahorro/savings-rate promedio.
--   'runway'            → con un ahorro acumulado p_goal_amount, cuántos
--                         meses durás si mantenés el gasto promedio.
--   'forecast_month'    → proyecta gasto e ingreso del MES ACTUAL al cierre,
--                         usando el ritmo del mes hasta hoy.
--
-- Overrides (opcionales):
--   p_monthly_saving_override   — fija el ahorro mensual
--   p_monthly_income_override   — fija el ingreso mensual
--   p_monthly_expense_override  — fija el gasto mensual
--   p_extra_monthly_saving      — sumar (o restar) al ahorro calculado
-- =====================================================================
CREATE OR REPLACE FUNCTION compute_financial_advice(
    p_user_id UUID,
    p_mode TEXT,
    p_goal_amount NUMERIC DEFAULT NULL,
    p_monthly_saving_override NUMERIC DEFAULT NULL,
    p_monthly_income_override NUMERIC DEFAULT NULL,
    p_monthly_expense_override NUMERIC DEFAULT NULL,
    p_lookback_months INT DEFAULT 3,
    p_extra_monthly_saving NUMERIC DEFAULT 0
)
RETURNS TABLE(
    mode TEXT,
    avg_monthly_income NUMERIC,
    avg_monthly_expense NUMERIC,
    monthly_saving NUMERIC,
    savings_rate_pct NUMERIC,
    months_used INT,
    months_to_goal NUMERIC,
    target_date DATE,
    affordable BOOLEAN,
    runway_months NUMERIC,
    projected_month_total_expense NUMERIC,
    projected_month_total_income NUMERIC,
    note TEXT
) AS $$
DECLARE
    v_lookback INT := GREATEST(COALESCE(p_lookback_months, 3), 1);
    v_period_start DATE :=
        (DATE_TRUNC('month', CURRENT_DATE) - (v_lookback || ' months')::INTERVAL)::DATE;
    v_period_end DATE :=
        (DATE_TRUNC('month', CURRENT_DATE)::DATE - INTERVAL '1 day')::DATE;
    v_total_inc NUMERIC := 0;
    v_total_exp NUMERIC := 0;
    v_distinct_months INT := 0;
    v_months_used INT := 0;
    v_avg_income NUMERIC := 0;
    v_avg_expense NUMERIC := 0;
    v_saving NUMERIC := 0;
    v_savings_rate NUMERIC := 0;
    v_curmo_inc NUMERIC := 0;
    v_curmo_exp NUMERIC := 0;
    v_days_elapsed INT := DATE_PART('day', CURRENT_DATE)::INT;
    v_days_in_month INT :=
        DATE_PART('day',
            (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')
        )::INT;
    -- mode-specific outputs
    v_months_to_goal NUMERIC := NULL;
    v_target_date DATE := NULL;
    v_affordable BOOLEAN := NULL;
    v_runway NUMERIC := NULL;
    v_proj_exp NUMERIC := NULL;
    v_proj_inc NUMERIC := NULL;
    v_note TEXT := '';
    v_fallback_used BOOLEAN := FALSE;
BEGIN
    IF p_mode IS NULL OR p_mode = '' THEN
        RAISE EXCEPTION 'compute_financial_advice: mode requerido';
    END IF;

    -- 1) totales históricos en meses completos previos
    SELECT
        COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0),
        COUNT(DISTINCT DATE_TRUNC('month', transaction_date))::INT
    INTO v_total_inc, v_total_exp, v_distinct_months
    FROM v_reportable_transactions
    WHERE user_id = p_user_id
      AND transaction_date BETWEEN v_period_start AND v_period_end;

    -- 2) totales del mes actual (para forecast y fallback)
    SELECT
        COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)
    INTO v_curmo_inc, v_curmo_exp
    FROM v_reportable_transactions
    WHERE user_id = p_user_id
      AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE);

    -- 3) elegir base de cálculo: meses completos > mes actual proporcional
    IF v_distinct_months > 0 THEN
        v_months_used := v_distinct_months;
        v_avg_income  := v_total_inc::NUMERIC  / v_months_used;
        v_avg_expense := v_total_exp::NUMERIC  / v_months_used;
    ELSIF v_days_elapsed > 0 AND (v_curmo_inc + v_curmo_exp) > 0 THEN
        -- fallback: usar mes actual proporcional
        v_months_used := 0;
        v_avg_income  := v_curmo_inc::NUMERIC / v_days_elapsed * v_days_in_month;
        v_avg_expense := v_curmo_exp::NUMERIC / v_days_elapsed * v_days_in_month;
        v_fallback_used := TRUE;
    ELSE
        v_months_used := 0;
        v_avg_income := 0;
        v_avg_expense := 0;
    END IF;

    -- 4) overrides
    IF p_monthly_income_override  IS NOT NULL THEN v_avg_income  := p_monthly_income_override;  END IF;
    IF p_monthly_expense_override IS NOT NULL THEN v_avg_expense := p_monthly_expense_override; END IF;

    v_saving := COALESCE(p_monthly_saving_override, v_avg_income - v_avg_expense)
              + COALESCE(p_extra_monthly_saving, 0);

    v_savings_rate := CASE
        WHEN v_avg_income > 0 THEN ROUND((v_saving / v_avg_income) * 100, 2)
        ELSE 0
    END;

    -- 5) dispatch por modo
    CASE LOWER(p_mode)
    WHEN 'time_to_goal' THEN
        IF p_goal_amount IS NULL OR p_goal_amount <= 0 THEN
            v_note := 'falta goal_amount válido (>0)';
        ELSIF v_saving <= 0 THEN
            v_note := 'al ritmo actual no estás ahorrando (gastás >= ingresos); meta inalcanzable sin ajustar';
        ELSE
            v_months_to_goal := ROUND(p_goal_amount::NUMERIC / v_saving, 2);
            v_target_date := (CURRENT_DATE + (CEIL(v_months_to_goal)::INT || ' months')::INTERVAL)::DATE;
            v_note := 'asumiendo ahorro mensual constante de ' || ROUND(v_saving, 0)::TEXT
                   || CASE WHEN v_fallback_used THEN ' (usando mes actual proporcional, todavía no hay historial completo)' ELSE '' END;
        END IF;

    WHEN 'affordability' THEN
        IF p_goal_amount IS NULL OR p_goal_amount <= 0 THEN
            v_note := 'falta goal_amount válido';
        ELSE
            v_affordable := v_saving >= p_goal_amount;
            IF v_saving <= 0 THEN
                v_note := 'tu ahorro mensual es 0 o negativo; ese gasto te hunde el mes';
            ELSIF v_affordable THEN
                v_note := 'tu ahorro mensual lo cubre de un saque';
            ELSE
                v_months_to_goal := ROUND(p_goal_amount::NUMERIC / v_saving, 2);
                v_note := 'no entra de un saque; necesitarías ' || v_months_to_goal::TEXT || ' meses ahorrando para cubrirlo';
            END IF;
        END IF;

    WHEN 'savings_capacity' THEN
        v_note := CASE WHEN v_fallback_used
            THEN 'ingreso/gasto basado en el mes actual proyectado (sin historial todavía)'
            ELSE 'promedio últimos ' || v_months_used::TEXT || ' meses con movimientos' END;

    WHEN 'runway' THEN
        IF p_goal_amount IS NULL OR p_goal_amount < 0 THEN
            v_note := 'pasá el ahorro acumulado actual en goal_amount';
        ELSIF v_avg_expense <= 0 THEN
            v_runway := NULL;
            v_note := 'sin gasto promedio: runway indefinido';
        ELSE
            v_runway := ROUND(p_goal_amount::NUMERIC / v_avg_expense, 2);
            v_note := 'meses que durás si dejás de cobrar y mantenés el gasto promedio actual';
        END IF;

    WHEN 'forecast_month' THEN
        IF v_days_elapsed > 0 THEN
            v_proj_exp := ROUND(v_curmo_exp::NUMERIC / v_days_elapsed * v_days_in_month, 2);
            v_proj_inc := ROUND(v_curmo_inc::NUMERIC / v_days_elapsed * v_days_in_month, 2);
        ELSE
            v_proj_exp := 0;
            v_proj_inc := 0;
        END IF;
        v_note := 'proyección lineal del cierre del mes (gasto-actual / días-transcurridos × días-del-mes)';

    ELSE
        RAISE EXCEPTION 'compute_financial_advice: mode desconocido %, valores válidos: time_to_goal | affordability | savings_capacity | runway | forecast_month', p_mode;
    END CASE;

    RETURN QUERY SELECT
        p_mode,
        ROUND(v_avg_income, 2),
        ROUND(v_avg_expense, 2),
        ROUND(v_saving, 2),
        v_savings_rate,
        v_months_used,
        v_months_to_goal,
        v_target_date,
        v_affordable,
        v_runway,
        v_proj_exp,
        v_proj_inc,
        v_note;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- SEMANTIC MEMORY (pgvector)
-- =====================================================================
-- Memoria persistente por usuario, indexada con embeddings de OpenAI.
-- El agente la usa de forma EXPLÍCITA — guarda hechos relevantes con
-- `remember_fact` y los recupera con `recall_memory(query)` cuando el
-- mensaje del usuario tiene contexto temporal/referencial vago
-- ("la semana pasada", "ese gasto que te dije", "el viaje aquel").
--
-- Decisiones de diseño:
--   • Embedding model: text-embedding-3-small (1536 dim, $0.02/1M tokens).
--   • Storage: vector(1536) — suficiente, escalable a HNSW.
--   • Index: HNSW con cosine — buen recall sin tunear ef_search.
--   • Ownership: row-level por user_id; función search_memory filtra antes.
--   • Soft delete: kind='__forgotten__' marca borrado lógico (audit trail).
--
-- Por qué OPCIONAL (no auto-embedding por turno):
--   • No queremos meter latencia + costo a cada mensaje.
--   • El agente es mejor que un heurístico pre-canned para decidir QUÉ
--     vale la pena recordar (preferencias, contexto de viaje, metas).
--   • Si después queremos auto-embedding, agregamos un trigger.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_chunks (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'fact',  -- 'fact'|'preference'|'context'|'goal'|'__forgotten__'|...
    content      TEXT NOT NULL,
    embedding    vector(1536) NOT NULL,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_recalled_at TIMESTAMPTZ,
    recall_count INT NOT NULL DEFAULT 0
);

-- HNSW index para búsqueda KNN por cosine. Filtramos por user_id ANTES de buscar.
-- Con pocos miles de chunks por user es overkill, pero crece bien.
CREATE INDEX IF NOT EXISTS idx_memory_chunks_user
    ON memory_chunks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
    ON memory_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_kind
    ON memory_chunks (user_id, kind) WHERE kind <> '__forgotten__';

-- ---------- add_memory_chunk ----------
-- Insert + dedup blando: si ya existe un chunk del mismo user con
-- similaridad >= 0.95 al nuevo embedding, NO duplica — actualiza recall_count.
CREATE OR REPLACE FUNCTION add_memory_chunk(
    p_user_id      UUID,
    p_kind         TEXT,
    p_content      TEXT,
    p_embedding    vector(1536),
    p_metadata     JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(id UUID, was_created BOOLEAN, content TEXT, kind TEXT) AS $$
DECLARE
    v_id UUID;
    v_existing UUID;
BEGIN
    IF p_user_id IS NULL OR p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'add_memory_chunk: user_id y content son requeridos';
    END IF;

    -- Dedup blando: 1 - cosine_distance >= 0.95 ↔ cosine_distance <= 0.05
    SELECT mc.id INTO v_existing
    FROM memory_chunks mc
    WHERE mc.user_id = p_user_id
      AND mc.kind <> '__forgotten__'
      AND mc.embedding <=> p_embedding <= 0.05
    ORDER BY mc.embedding <=> p_embedding
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
        UPDATE memory_chunks
        SET recall_count = recall_count + 1,
            last_recalled_at = NOW(),
            metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
        WHERE memory_chunks.id = v_existing
        RETURNING memory_chunks.id INTO v_id;
        RETURN QUERY
        SELECT v_id, FALSE,
               (SELECT mc.content FROM memory_chunks mc WHERE mc.id = v_id),
               (SELECT mc.kind    FROM memory_chunks mc WHERE mc.id = v_id);
        RETURN;
    END IF;

    INSERT INTO memory_chunks (user_id, kind, content, embedding, metadata)
    VALUES (p_user_id, COALESCE(NULLIF(p_kind, ''), 'fact'),
            trim(p_content), p_embedding, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING memory_chunks.id INTO v_id;

    RETURN QUERY
    SELECT v_id, TRUE, p_content, COALESCE(NULLIF(p_kind, ''), 'fact');
END;
$$ LANGUAGE plpgsql;

-- ---------- search_memory_chunks ----------
-- KNN search por cosine. Devuelve top K filtrado por user (siempre) y
-- opcionalmente por kind. Excluye soft-deleted.
CREATE OR REPLACE FUNCTION search_memory_chunks(
    p_user_id     UUID,
    p_embedding   vector(1536),
    p_k           INT DEFAULT 5,
    p_kind        TEXT DEFAULT NULL,
    p_min_score   REAL DEFAULT 0.65  -- 1-cosine_distance ≥ 0.65 (subido de 0.5 → menos ruido)
)
RETURNS TABLE(
    id          UUID,
    kind        TEXT,
    content     TEXT,
    metadata    JSONB,
    similarity  REAL,
    created_at  TIMESTAMPTZ,
    recall_count INT
) AS $$
DECLARE
    v_k INT := GREATEST(COALESCE(p_k, 5), 1);
BEGIN
    RETURN QUERY
    SELECT mc.id,
           mc.kind,
           mc.content,
           mc.metadata,
           (1 - (mc.embedding <=> p_embedding))::REAL AS similarity,
           mc.created_at,
           mc.recall_count
    FROM memory_chunks mc
    WHERE mc.user_id = p_user_id
      AND mc.kind <> '__forgotten__'
      AND (p_kind IS NULL OR mc.kind = p_kind)
      AND (1 - (mc.embedding <=> p_embedding))::REAL >= p_min_score
    ORDER BY mc.embedding <=> p_embedding
    LIMIT v_k;

    -- Bumpear recall_count para los chunks recuperados (separado para no
    -- alterar el ORDER BY KNN).
    UPDATE memory_chunks mc
    SET recall_count = mc.recall_count + 1, last_recalled_at = NOW()
    WHERE mc.user_id = p_user_id
      AND mc.kind <> '__forgotten__'
      AND (p_kind IS NULL OR mc.kind = p_kind)
      AND mc.id IN (
          SELECT mc2.id FROM memory_chunks mc2
          WHERE mc2.user_id = p_user_id
            AND mc2.kind <> '__forgotten__'
            AND (p_kind IS NULL OR mc2.kind = p_kind)
            AND (1 - (mc2.embedding <=> p_embedding))::REAL >= p_min_score
          ORDER BY mc2.embedding <=> p_embedding
          LIMIT v_k
      );
END;
$$ LANGUAGE plpgsql;

-- ---------- forget_memory_chunk ----------
-- Soft-delete por id, con dueño-check. El chunk queda en la tabla con
-- kind='__forgotten__' (audit trail) y deja de aparecer en search.
CREATE OR REPLACE FUNCTION forget_memory_chunk(
    p_user_id UUID,
    p_id      UUID
)
RETURNS TABLE(id UUID, forgot BOOLEAN) AS $$
BEGIN
    UPDATE memory_chunks mc
    SET kind = '__forgotten__'
    WHERE mc.id = p_id AND mc.user_id = p_user_id AND mc.kind <> '__forgotten__';
    IF FOUND THEN
        RETURN QUERY SELECT p_id, TRUE;
    ELSE
        RETURN QUERY SELECT p_id, FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- update_memory_chunk ----------
-- Actualiza content + embedding + (opcional) kind y metadata de un chunk existente.
-- Se usa cuando un hecho evoluciona (ej. "ahorra 500k" → "ahora ahorra 700k") sin
-- perder el id ni romper referencias. Re-embedea el contenido nuevo.
-- Si p_id no pertenece al user → updated=false.
CREATE OR REPLACE FUNCTION update_memory_chunk(
    p_user_id      UUID,
    p_id           UUID,
    p_new_content  TEXT,
    p_new_embedding vector(1536),
    p_new_kind     TEXT DEFAULT NULL,
    p_new_metadata JSONB DEFAULT NULL
)
RETURNS TABLE(id UUID, updated BOOLEAN, content TEXT, kind TEXT) AS $$
BEGIN
    IF p_user_id IS NULL OR p_id IS NULL OR p_new_content IS NULL OR length(trim(p_new_content)) = 0 THEN
        RAISE EXCEPTION 'update_memory_chunk: user_id, id y new_content son requeridos';
    END IF;

    UPDATE memory_chunks mc
    SET content = trim(p_new_content),
        embedding = p_new_embedding,
        kind = COALESCE(NULLIF(p_new_kind, ''), mc.kind),
        metadata = CASE WHEN p_new_metadata IS NOT NULL THEN mc.metadata || p_new_metadata ELSE mc.metadata END
    WHERE mc.id = p_id
      AND mc.user_id = p_user_id
      AND mc.kind <> '__forgotten__';

    IF FOUND THEN
        RETURN QUERY
        SELECT mc.id, TRUE, mc.content, mc.kind
        FROM memory_chunks mc WHERE mc.id = p_id;
    ELSE
        RETURN QUERY SELECT p_id, FALSE, NULL::TEXT, NULL::TEXT;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- list_memory_chunks ----------
-- Listado simple por user, con filtros opcionales — útil para "qué recordás de mí".
CREATE OR REPLACE FUNCTION list_memory_chunks(
    p_user_id UUID,
    p_kind    TEXT DEFAULT NULL,
    p_limit   INT DEFAULT 20
)
RETURNS TABLE(
    id          UUID,
    kind        TEXT,
    content     TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ,
    recall_count INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT mc.id, mc.kind, mc.content, mc.metadata, mc.created_at, mc.recall_count
    FROM memory_chunks mc
    WHERE mc.user_id = p_user_id
      AND mc.kind <> '__forgotten__'
      AND (p_kind IS NULL OR mc.kind = p_kind)
    ORDER BY mc.recall_count DESC, mc.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 20), 1);
END;
$$ LANGUAGE plpgsql STABLE;
