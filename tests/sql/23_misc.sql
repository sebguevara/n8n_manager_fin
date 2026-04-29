-- Test: normalize_text + pick_reply + format_reply
SELECT set_config('test.uid', :'uid', false);
\set ON_ERROR_STOP on

DO $$
DECLARE
    s TEXT;
BEGIN
    -- normalize_text: lower, trim, unaccent
    IF normalize_text('Café  ') <> 'cafe' THEN RAISE EXCEPTION '[normalize_text] got "%"', normalize_text('Café  '); END IF;
    IF normalize_text('  ÑOÑO ') <> 'nono' THEN RAISE EXCEPTION '[normalize_text ñ] got "%"', normalize_text('  ÑOÑO '); END IF;
    IF normalize_text(NULL) <> '' THEN RAISE EXCEPTION '[normalize_text null] got "%"', normalize_text(NULL); END IF;

    -- pick_reply: returns a template for known kind
    s := pick_reply('expense_logged');
    IF s IS NULL OR s = '' THEN RAISE EXCEPTION '[pick_reply] returned empty for expense_logged'; END IF;

    -- pick_reply unknown kind returns ''
    s := pick_reply('zzz_unknown_kind_zzz');
    IF s <> '' THEN RAISE EXCEPTION '[pick_reply unknown] got "%"', s; END IF;

    -- format_reply substitutes placeholders
    s := format_reply('expense_logged', 1500::numeric, 'Comida', 'café', CURRENT_DATE);
    IF s IS NULL OR position('Comida' IN s) = 0 THEN RAISE EXCEPTION '[format_reply] no substitution: %', s; END IF;
    IF position('1.500,00' IN s) = 0 AND position('1500' IN s) = 0 THEN
        RAISE EXCEPTION '[format_reply amount] no amount: %', s;
    END IF;

    RAISE NOTICE 'PASS misc (normalize + pick_reply + format_reply)';
END $$;
