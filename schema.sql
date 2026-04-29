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
CREATE OR REPLACE FUNCTION process_due_recurring()
RETURNS TABLE(user_id UUID, phone TEXT, transaction_id UUID, amount NUMERIC, description TEXT, category_name TEXT) AS $$
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT r.id AS rec_id, r.user_id, r.amount, r.description, r.category_id, r.payment_method_id,
               r.next_occurrence, r.frequency, r.metadata
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
        RETURNING id, user_id, amount, description, category_id, transaction_date
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
            SELECT COALESCE(jsonb_agg(t ORDER BY t.transaction_date DESC, t.created_at DESC), '[]'::jsonb) FROM (
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

    INSERT INTO budgets (user_id, category_id, amount, period, is_active)
    VALUES (p_user_id, v_cat_id, p_amount, p_period, TRUE)
    ON CONFLICT (user_id, category_id, period) DO UPDATE
    SET amount = EXCLUDED.amount, is_active = TRUE;

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

-- Edit a transaction by id (returns updated row)
CREATE OR REPLACE FUNCTION update_tx(
    p_user_id UUID,
    p_tx_id UUID,
    p_new_date DATE DEFAULT NULL,
    p_new_amount NUMERIC DEFAULT NULL,
    p_new_description TEXT DEFAULT NULL,
    p_new_category_id UUID DEFAULT NULL
)
RETURNS TABLE(id UUID, amount NUMERIC, description TEXT, transaction_date DATE, category_name TEXT) AS $$
BEGIN
    RETURN QUERY
    UPDATE transactions t
    SET transaction_date = COALESCE(p_new_date, t.transaction_date),
        amount = COALESCE(p_new_amount, t.amount),
        description = COALESCE(NULLIF(p_new_description, ''), t.description),
        category_id = COALESCE(p_new_category_id, t.category_id),
        updated_at = NOW()
    WHERE t.id = p_tx_id AND t.user_id = p_user_id
    RETURNING t.id, t.amount, t.description, t.transaction_date,
              (SELECT c.name FROM categories c WHERE c.id = t.category_id);
END;
$$ LANGUAGE plpgsql;
