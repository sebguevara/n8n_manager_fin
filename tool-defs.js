// Tool definitions shared between build-agent-workflow.js (consumes them as
// agent-side tool nodes with $fromAI typed fields) and build-tools-subworkflow.js
// (uses the union of fields to declare the executeWorkflowTrigger schema, so n8n's
// tool nodes can validate their workflowInputs against a real schema and the UI
// stops showing 'Workflow inputs are outdated').
//
// Field shape: { name, desc, type, default? }
//   type: 'string' | 'number' | 'boolean' | 'json' (json = nested object/array)
//   default: provided when LLM omits → makes Zod treat as optional

module.exports = [
    {
        name: 'query_transactions',
        description: 'Lista transacciones con filtros y paginación. Úsala para "mostrame los movs", "los últimos", "todos los gastos del mes".',
        fields: [
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all|custom. Default this_month si no especifican; all si pidieron datos específicos por monto/fecha.', type: 'string', default: 'this_month' },
            { name: 'start_date', desc: 'YYYY-MM-DD (solo si period=custom)', type: 'string', default: '' },
            { name: 'end_date', desc: 'YYYY-MM-DD (solo si period=custom)', type: 'string', default: '' },
            { name: 'category', desc: 'Filtro por categoría', type: 'string', default: '' },
            { name: 'description_contains', desc: 'Busca texto en la descripción. SOLO si el usuario menciona texto explícito (ej. "café", "uber").', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'both' },
            { name: 'group_name', desc: 'Nombre de grupo/viaje', type: 'string', default: '' },
            { name: 'payment_method', desc: 'Método de pago', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'min_amount', desc: 'Monto mínimo', type: 'number', default: 0 },
            { name: 'max_amount', desc: 'Monto máximo', type: 'number', default: 0 },
            { name: 'sort', desc: 'date_desc|date_asc|amount_desc|amount_asc', type: 'string', default: 'date_desc' },
            { name: 'limit', desc: 'Cantidad de resultados', type: 'number', default: 20 },
            { name: 'offset', desc: 'Paginación offset', type: 'number', default: 0 }
        ]
    },
    {
        name: 'get_total',
        description: 'Total y count de gastos/ingresos en un período. Para "cuánto gasté", "total del mes", "cuánto en comida".',
        fields: [
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all|custom', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'expense' },
            { name: 'category', desc: 'Filtro por categoría', type: 'string', default: '' },
            { name: 'group_name', desc: 'Filtro por grupo', type: 'string', default: '' }
        ]
    },
    {
        name: 'get_breakdown',
        description: 'Desglose agrupado por dimensión. Para "en qué gasté más", "por categoría", "por día".',
        fields: [
            { name: 'dimension', desc: 'category|day|week|month|payment_method|group', type: 'string', default: 'category' },
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'top_n', desc: 'Top N filas', type: 'number', default: 10 }
        ]
    },
    {
        name: 'compare_periods',
        description: 'Compara totales entre dos períodos. Para "este mes vs el pasado".',
        fields: [
            { name: 'period_a', desc: 'Período A', type: 'string', default: 'this_month' },
            { name: 'period_b', desc: 'Período B', type: 'string', default: 'last_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' }
        ]
    },
    {
        name: 'find_transactions',
        description: 'Busca transacciones específicas para luego borrarlas/editarlas. Devuelve TODAS las matches con score. Llamá ANTES de cualquier delete/update por hint.',
        fields: [
            { name: 'description_contains', desc: 'Texto a buscar en descripción', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'min_amount', desc: 'Monto mínimo', type: 'number', default: 0 },
            { name: 'max_amount', desc: 'Monto máximo', type: 'number', default: 0 },
            { name: 'date', desc: 'Fecha exacta YYYY-MM-DD', type: 'string', default: '' },
            { name: 'date_from', desc: 'Desde fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'date_to', desc: 'Hasta fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'category', desc: 'Categoría', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: '' },
            { name: 'group_name', desc: 'Grupo', type: 'string', default: '' },
            { name: 'limit', desc: 'Max resultados', type: 'number', default: 20 }
        ]
    },
    {
        name: 'find_duplicates',
        description: 'Detecta gastos repetidos. Para "elimina los repetidos", "tengo gastos duplicados".',
        fields: [
            { name: 'window_days', desc: 'Ventana de días para considerar duplicado', type: 'number', default: 7 },
            { name: 'min_repetitions', desc: 'Mínimo de repeticiones', type: 'number', default: 2 }
        ]
    },
    {
        name: 'bulk_preview',
        description: 'Preview ANTES de borrar/editar masivo. USALA OBLIGATORIAMENTE antes de bulk_delete por criterio.',
        fields: [
            { name: 'period', desc: 'Período', type: 'string', default: 'all' },
            { name: 'category', desc: 'Filtro categoría', type: 'string', default: '' },
            { name: 'description_contains', desc: 'Texto a buscar', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'date', desc: 'Fecha exacta', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: '' }
        ]
    },
    {
        name: 'bulk_delete',
        description: 'Borra múltiples transacciones por lista de UUIDs. Solo después de bulk_preview o find_transactions + confirmación.',
        fields: [
            { name: 'ids', desc: 'Array JSON de UUIDs (string). Ejemplo: ["uuid1","uuid2"]', type: 'json', default: [] }
        ]
    },
    {
        name: 'bulk_update',
        description: 'Actualiza múltiples transacciones por UUIDs. Para cambiar la categoría usá new_category_hint con el nombre (no UUID). Para SET (pisar) un monto absoluto usá new_amount; para sumar/restar relativo usá amount_delta.',
        fields: [
            { name: 'ids', desc: 'Array JSON de UUIDs', type: 'json', default: [] },
            { name: 'new_category_hint', desc: 'Nombre de categoría destino (ej. "comida"). La función la resuelve por nombre.', type: 'string', default: '' },
            { name: 'create_category_if_missing', desc: 'true si querés crear la categoría si no existe. false para fuzzy match contra existentes.', type: 'boolean', default: false },
            { name: 'new_date', desc: 'Nueva fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_group_id', desc: 'Nuevo grupo UUID', type: 'string', default: '' },
            { name: 'new_amount', desc: 'SET nuevo monto absoluto (pisa el actual). Ej: cambiá los 3 cafés a $5000 cada uno.', type: 'number', default: 0 },
            { name: 'amount_delta', desc: 'SUMA/RESTA al monto actual. Ej: ajustá +$200 por propina a estos 3.', type: 'number', default: 0 },
            { name: 'new_description', desc: 'SET nueva descripción para todos', type: 'string', default: '' },
            { name: 'set_excluded', desc: 'Marcar excluidas', type: 'boolean', default: false }
        ]
    },
    {
        name: 'log_transaction',
        description: 'Registra UN gasto o ingreso nuevo. SIEMPRE extraé del mensaje el monto, descripción y categoría antes de llamar.',
        fields: [
            { name: 'amount', desc: 'Monto en pesos (número entero o decimal, sin signos ni separadores). Ej: 3300', type: 'number', default: 0 },
            { name: 'description', desc: 'Descripción del gasto/ingreso', type: 'string', default: '' },
            { name: 'category_hint', desc: 'Nombre de categoría existente o nueva (ej. comida, salud, salidas, viajes). NO uses "transferencias" — eso es método de pago, no categoría.', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'date', desc: 'Fecha YYYY-MM-DD si fue mencionada explícitamente. Vacío para hoy.', type: 'string', default: '' },
            { name: 'payment_method_hint', desc: 'efectivo|debito|credito|transferencia|mercado_pago|otro. Si fue transferencia, va ACÁ — NO en category_hint.', type: 'string', default: '' },
            { name: 'group_hint', desc: 'Nombre del viaje/evento al que pertenece', type: 'string', default: '' },
            { name: 'skip_dup_check', desc: 'true solo si el usuario confirmó registrar duplicado', type: 'boolean', default: false },
            { name: 'create_category_if_missing', desc: 'true cuando el usuario aclaró la categoría (puede ser nueva, hay que crearla). false en flujos automáticos donde solo querés matchear con existentes.', type: 'boolean', default: false }
        ]
    },
    {
        name: 'update_transaction',
        description: 'Edita UNA transacción por UUID. Para cambiar la categoría usá new_category_hint con el NOMBRE (no UUID).',
        fields: [
            { name: 'transaction_id', desc: 'UUID de la transacción a editar', type: 'string', default: '' },
            { name: 'new_date', desc: 'Nueva fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_amount', desc: 'Nuevo monto', type: 'number', default: 0 },
            { name: 'new_description', desc: 'Nueva descripción', type: 'string', default: '' },
            { name: 'new_category_hint', desc: 'Nombre de categoría destino (ej. "comida", "salud"). La función resuelve por nombre — NO mandes UUID.', type: 'string', default: '' },
            { name: 'create_category_if_missing', desc: 'true si querés crear la categoría si no existe (cuando el usuario nombra una nueva). false para fuzzy match contra existentes.', type: 'boolean', default: false }
        ]
    },
    {
        name: 'delete_transaction',
        description: 'Borra UNA transacción por UUID.',
        fields: [
            { name: 'transaction_id', desc: 'UUID de la transacción a borrar', type: 'string', default: '' }
        ]
    },
    {
        name: 'list_categories',
        description: 'Lista todas las categorías del usuario con sus emojis y conteos.',
        fields: [
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'both' },
            { name: 'include_excluded', desc: 'Incluir categorías excluidas', type: 'boolean', default: false }
        ]
    },
    {
        name: 'list_groups',
        description: 'Lista grupos (viajes/eventos/proyectos) con totales.',
        fields: []
    },
    {
        name: 'list_budgets',
        description: 'Lista presupuestos activos con consumo actual y % usado.',
        fields: []
    },
    {
        name: 'set_budget',
        description: 'Crea o actualiza un presupuesto para una categoría.',
        fields: [
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: '' },
            { name: 'amount', desc: 'Monto del presupuesto', type: 'number', default: 0 },
            { name: 'period', desc: 'weekly|monthly|yearly', type: 'string', default: 'monthly' }
        ]
    },
    {
        name: 'create_group',
        description: 'Crea un grupo (viaje/evento/proyecto).',
        fields: [
            { name: 'name', desc: 'Nombre del grupo', type: 'string', default: '' },
            { name: 'kind', desc: 'trip|event|emergency|project|other', type: 'string', default: 'event' }
        ]
    },
    {
        name: 'toggle_category_exclusion',
        description: 'Excluye/incluye una categoría de los reportes.',
        fields: [
            { name: 'category_hint', desc: 'Categoría a excluir/incluir', type: 'string', default: '' }
        ]
    },
    {
        name: 'create_category',
        description: 'Crea una categoría nueva del usuario (sin asociarla a ningún gasto). Usala cuando el usuario diga "creá la categoría X" o "quiero tener una categoría llamada X". Si ya existe (exact o fuzzy), la devuelve sin duplicar (was_created=false).',
        fields: [
            { name: 'name', desc: 'Nombre de la categoría a crear (ej. "salidas", "regalos", "ahorros")', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income — tipo de la categoría. Default expense.', type: 'string', default: 'expense' }
        ]
    },
    {
        name: 'rename_category',
        description: 'Cambia el nombre de una categoría existente del usuario. Usala cuando el usuario diga "cambiá X por Y" o "renombrá X a Y". Falla si Y ya existe (en ese caso usá delete_category con merge_into).',
        fields: [
            { name: 'old_name', desc: 'Nombre actual de la categoría', type: 'string', default: '' },
            { name: 'new_name', desc: 'Nombre nuevo', type: 'string', default: '' }
        ]
    },
    {
        name: 'delete_category',
        description: 'Borra (soft-delete) una categoría del usuario. Si tiene transacciones u otras dependencias, hay que pasar merge_into con el nombre de otra categoría destino para fusionar primero. Si está vacía, se desactiva directo.',
        fields: [
            { name: 'name', desc: 'Nombre de la categoría a borrar', type: 'string', default: '' },
            { name: 'merge_into', desc: 'Nombre de la categoría destino donde mover las transacciones/presupuestos antes de borrar. Vacío si la categoría está vacía y solo querés desactivarla.', type: 'string', default: '' }
        ]
    },
    // ----- Recurrentes (CRUD) -----
    {
        name: 'list_recurring',
        description: 'Lista las recurrentes (Netflix, alquiler, etc.) del usuario con monto, frecuencia y próxima ocurrencia.',
        fields: [
            { name: 'active_only', desc: 'true para solo activas; false incluye pausadas/canceladas', type: 'boolean', default: true }
        ]
    },
    {
        name: 'find_recurring_by_hint',
        description: 'Búsqueda dirigida de recurrentes por nombre/descripción (ej. "alquiler", "netflix"). Devuelve hasta 5 candidatos con su recurring_id. SIEMPRE preferí esta tool sobre list_recurring cuando el usuario refiere a una recurrente puntual por nombre — es más rápido y preciso.',
        fields: [
            { name: 'hint', desc: 'Texto a buscar (description). Ej. "alquiler", "netflix", "spotify".', type: 'string', default: '' }
        ]
    },
    {
        name: 'update_recurring',
        description: 'Edita una recurrente existente. Para cambiar la categoría usá new_category_hint (nombre, no UUID).',
        fields: [
            { name: 'recurring_id', desc: 'UUID de la recurrente. Obtenelo con list_recurring.', type: 'string', default: '' },
            { name: 'new_amount', desc: 'Nuevo monto', type: 'number', default: 0 },
            { name: 'new_description', desc: 'Nueva descripción', type: 'string', default: '' },
            { name: 'new_frequency', desc: 'daily|weekly|monthly|yearly', type: 'string', default: '' },
            { name: 'new_category_hint', desc: 'Nombre de categoría destino (ej. "comida")', type: 'string', default: '' },
            { name: 'new_next_occurrence', desc: 'Próxima fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_end_date', desc: 'Fecha de fin YYYY-MM-DD (vacío = sin fin)', type: 'string', default: '' },
            { name: 'create_category_if_missing', desc: 'true si la categoría puede ser nueva', type: 'boolean', default: false }
        ]
    },
    {
        name: 'pause_recurring',
        description: 'Pausa una recurrente (deja de generar tx automáticas) sin borrarla. Reanudable con resume_recurring.',
        fields: [
            { name: 'recurring_id', desc: 'UUID de la recurrente', type: 'string', default: '' }
        ]
    },
    {
        name: 'resume_recurring',
        description: 'Reanuda una recurrente pausada. Si la próxima fecha es pasada, la mueve a hoy.',
        fields: [
            { name: 'recurring_id', desc: 'UUID de la recurrente', type: 'string', default: '' }
        ]
    },
    {
        name: 'cancel_recurring',
        description: 'Cancela una recurrente definitivamente (cierre con end_date=hoy). Para volver a usarla hay que crear una nueva con set_recurring.',
        fields: [
            { name: 'recurring_id', desc: 'UUID de la recurrente', type: 'string', default: '' }
        ]
    },
    // ----- Grupos (CRUD) -----
    {
        name: 'update_group',
        description: 'Edita un grupo (viaje/evento/proyecto): nombre, kind, fechas o emoji. Solo modifica los campos que pasás.',
        fields: [
            { name: 'name', desc: 'Nombre actual del grupo (lookup)', type: 'string', default: '' },
            { name: 'new_name', desc: 'Nuevo nombre', type: 'string', default: '' },
            { name: 'new_kind', desc: 'trip|event|emergency|project|other', type: 'string', default: '' },
            { name: 'new_emoji', desc: 'Nuevo emoji', type: 'string', default: '' },
            { name: 'new_starts_at', desc: 'Fecha de inicio YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_ends_at', desc: 'Fecha de fin YYYY-MM-DD', type: 'string', default: '' }
        ]
    },
    {
        name: 'rename_group',
        description: 'Renombra un grupo. Atajo de update_group cuando solo cambia el nombre.',
        fields: [
            { name: 'old_name', desc: 'Nombre actual', type: 'string', default: '' },
            { name: 'new_name', desc: 'Nuevo nombre', type: 'string', default: '' }
        ]
    },
    {
        name: 'close_group',
        description: 'Cierra un grupo: lo desactiva y le pone ends_at=hoy. Las transacciones siguen ahí; solo deja de aceptar nuevas.',
        fields: [
            { name: 'name', desc: 'Nombre del grupo a cerrar', type: 'string', default: '' }
        ]
    },
    {
        name: 'delete_group',
        description: 'Borra un grupo definitivamente. Si tiene transacciones, hay que pasar reassign_to_name (mover a otro grupo) O unassign=true (dejarlas sin grupo). Si está vacío, se borra directo.',
        fields: [
            { name: 'name', desc: 'Nombre del grupo a borrar', type: 'string', default: '' },
            { name: 'reassign_to_name', desc: 'Nombre del grupo destino (vacío si vas a desasignar)', type: 'string', default: '' },
            { name: 'unassign', desc: 'true para dejar las tx sin grupo (group_id=NULL)', type: 'boolean', default: false }
        ]
    },
    // ----- Presupuestos (D + pause) -----
    {
        name: 'delete_budget',
        description: 'Borra un presupuesto. Para reemplazar por uno nuevo usá set_budget directamente (es upsert).',
        fields: [
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: '' },
            { name: 'period', desc: 'weekly|monthly|yearly. Vacío borra todos los periodos de esa categoría.', type: 'string', default: '' }
        ]
    },
    {
        name: 'pause_budget',
        description: 'Pausa un presupuesto (no genera alertas) sin borrarlo. Reanudable con resume_budget.',
        fields: [
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: '' },
            { name: 'period', desc: 'weekly|monthly|yearly. Vacío pausa todos.', type: 'string', default: '' }
        ]
    },
    {
        name: 'resume_budget',
        description: 'Reactiva un presupuesto pausado.',
        fields: [
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: '' },
            { name: 'period', desc: 'weekly|monthly|yearly. Vacío reanuda todos.', type: 'string', default: '' }
        ]
    },
    // ----- Tags (CRUD + tag/untag + sugerencias) -----
    {
        name: 'list_tags',
        description: 'Lista los tags del usuario con conteo de tx y total gastado por tag. Útil para mostrar resúmenes.',
        fields: []
    },
    {
        name: 'create_tag',
        description: 'Crea un tag (etiqueta cross-categoría). Idempotente: si ya existe, lo devuelve.',
        fields: [
            { name: 'name', desc: 'Nombre del tag (ej. "regalos-cumple-mama", "viaje-2026")', type: 'string', default: '' },
            { name: 'color', desc: 'Color hex opcional (ej. "#FF6B6B")', type: 'string', default: '' }
        ]
    },
    {
        name: 'rename_tag',
        description: 'Renombra un tag. Falla si el nombre nuevo ya existe.',
        fields: [
            { name: 'old_name', desc: 'Nombre actual', type: 'string', default: '' },
            { name: 'new_name', desc: 'Nombre nuevo', type: 'string', default: '' }
        ]
    },
    {
        name: 'delete_tag',
        description: 'Borra un tag. Las transacciones que lo tenían pierden la etiqueta pero siguen existiendo.',
        fields: [
            { name: 'name', desc: 'Nombre del tag', type: 'string', default: '' }
        ]
    },
    {
        name: 'tag_transactions',
        description: 'Aplica un tag a varias transacciones. Idempotente. Si create_if_missing=true crea el tag si no existe.',
        fields: [
            { name: 'tag_name', desc: 'Nombre del tag', type: 'string', default: '' },
            { name: 'tx_ids', desc: 'Array de UUIDs de transacciones (obtenelos con find_transactions/query_transactions)', type: 'json', default: [] },
            { name: 'create_if_missing', desc: 'true para crear el tag si no existe', type: 'boolean', default: true }
        ]
    },
    {
        name: 'untag_transactions',
        description: 'Quita un tag de varias transacciones.',
        fields: [
            { name: 'tag_name', desc: 'Nombre del tag', type: 'string', default: '' },
            { name: 'tx_ids', desc: 'Array de UUIDs de transacciones', type: 'json', default: [] }
        ]
    },
    {
        name: 'suggest_tags',
        description: 'Sugiere tags relevantes para una descripción (basándose en tx similares ya tageadas). Llamala ANTES de pedirle al usuario que recuerde tags de memoria — así le ofrecés opciones.',
        fields: [
            { name: 'description', desc: 'Texto del gasto o búsqueda', type: 'string', default: '' },
            { name: 'amount', desc: 'Monto opcional para refinar', type: 'number', default: 0 },
            { name: 'limit', desc: 'Cantidad máxima de sugerencias', type: 'number', default: 5 }
        ]
    },
    // ----- Settings del usuario -----
    {
        name: 'get_settings',
        description: 'Trae las preferencias actuales del usuario (moneda, hora del resumen diario, summaries habilitados, nombre).',
        fields: []
    },
    {
        name: 'update_settings',
        description: 'Actualiza las preferencias del usuario. Solo cambia lo que le pasás.',
        fields: [
            { name: 'name', desc: 'Nombre del usuario', type: 'string', default: '' },
            { name: 'preferred_currency', desc: 'Código ISO (ej. ARS, USD, EUR)', type: 'string', default: '' },
            { name: 'daily_summary_enabled', desc: 'true para recibir resumen diario', type: 'string', default: '' },
            { name: 'daily_summary_hour', desc: 'Hora del resumen diario (0-23)', type: 'number', default: 0 },
            { name: 'weekly_summary_enabled', desc: 'true para recibir resumen semanal', type: 'string', default: '' }
        ]
    },
    {
        name: 'set_recurring',
        description: 'Crea una transacción recurrente (Netflix, alquiler, etc).',
        fields: [
            { name: 'amount', desc: 'Monto recurrente', type: 'number', default: 0 },
            { name: 'description', desc: 'Descripción', type: 'string', default: '' },
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: 'otros' },
            { name: 'frequency', desc: 'daily|weekly|biweekly|monthly|yearly', type: 'string', default: 'monthly' },
            { name: 'start_date', desc: 'YYYY-MM-DD', type: 'string', default: '' }
        ]
    },
    {
        name: 'remember_last_list',
        description: 'Guarda la última lista mostrada al usuario para resolver referencias deícticas. LLAMALA después de query_transactions / find_transactions cuando muestres una lista.',
        fields: [
            { name: 'kind', desc: 'transactions|duplicate_clusters|categories|groups', type: 'string', default: 'transactions' },
            { name: 'items', desc: 'Array de objetos. Ej: [{"position":1,"id":"uuid","date":"...","amount":123}]', type: 'json', default: [] },
            { name: 'filters_applied', desc: 'Filtros aplicados (objeto JSON)', type: 'json', default: {} },
            { name: 'ttl_seconds', desc: 'TTL en segundos', type: 'number', default: 600 }
        ]
    },
    {
        name: 'get_last_list',
        description: 'Recupera la última lista mostrada al usuario. Llamala cuando el usuario use deícticos como "el primero", "esos dos".',
        fields: []
    },
    {
        name: 'set_conv_state',
        description: 'Setea estado conversacional pendiente (ej. awaiting_bulk_delete antes de confirmar).',
        fields: [
            { name: 'state', desc: 'Nombre del estado', type: 'string', default: '' },
            { name: 'context', desc: 'Contexto (objeto JSON)', type: 'json', default: {} },
            { name: 'ttl_seconds', desc: 'TTL en segundos', type: 'number', default: 600 }
        ]
    },
    {
        name: 'clear_conv_state',
        description: 'Limpia el estado conversacional. Llamala después de resolver una confirmación.',
        fields: []
    },
    {
        name: 'generate_chart',
        description: 'Genera un gráfico (URL de imagen). En tu reply final usá reply_kind="image" e image_url.',
        fields: [
            { name: 'dimension', desc: 'category|day|payment_method', type: 'string', default: 'category' },
            { name: 'period', desc: 'today|this_week|this_month|last_month|this_year', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'top_n', desc: 'Top N', type: 'number', default: 10 }
        ]
    },
    // ----- Asesor financiero -----
    {
        name: 'financial_advice',
        description: '🎯 ASESOR FINANCIERO. Calcula respuestas determinísticas a preguntas tipo "¿en cuánto tiempo junto X?", "¿puedo gastar X?", "¿cuánto ahorro?", "¿cuánto me dura la plata?", "¿cuánto voy a gastar este mes?". USA datos reales del usuario (promedios de los últimos meses). Modos: time_to_goal | affordability | savings_capacity | runway | forecast_month. Si el usuario dice un override (ej. "ahorro 600k al mes"), pasalo en monthly_saving_override y la función lo respeta sobre el promedio de la DB.',
        fields: [
            { name: 'mode', desc: 'time_to_goal (cuánto tardo en juntar X) | affordability (¿puedo pagar X?) | savings_capacity (cuál es mi ahorro mensual) | runway (cuánto me dura un ahorro acumulado) | forecast_month (proyección del mes actual)', type: 'string', default: 'savings_capacity' },
            { name: 'goal_amount', desc: 'Monto en pesos: meta a juntar (time_to_goal), gasto a evaluar (affordability), o ahorro acumulado actual (runway). Vacío para savings_capacity y forecast_month.', type: 'number', default: 0 },
            { name: 'monthly_saving_override', desc: 'Ahorro mensual que el usuario afirma. Si lo decís ("ahorro 600k al mes"), pasalo acá: pisa el cálculo income-expense.', type: 'number', default: 0 },
            { name: 'monthly_income_override', desc: 'Ingreso mensual fijo declarado por el usuario.', type: 'number', default: 0 },
            { name: 'monthly_expense_override', desc: 'Gasto mensual fijo declarado por el usuario.', type: 'number', default: 0 },
            { name: 'lookback_months', desc: 'Cuántos meses calendario completos hacia atrás para el promedio (default 3).', type: 'number', default: 3 },
            { name: 'extra_monthly_saving', desc: 'Plata extra que el usuario podría poner (positivo) o que tendría que sacar (negativo) para ajustar el ritmo. Sumate al saving calculado.', type: 'number', default: 0 }
        ]
    },

    // ----- Memoria semántica (pgvector) -----
    {
        name: 'remember_fact',
        description: '🧠 GUARDA UN HECHO en memoria persistente del usuario. Para cuando el usuario aclare una preferencia, contexto, meta, o cualquier dato que valga la pena recordar entre conversaciones (más allá de los últimos 20 turnos del chat history). Ejemplos: "soy vegetariano y me cobran extra los uber-eats", "estoy juntando para una compu de 1.5M antes de fin de año", "Maxi es mi hermano y le devuelvo plata todos los meses", "trabajo desde casa, los cafés del Starbucks no son representativos". NO uses esto para registrar transacciones (eso es log_transaction). El return puede traer `has_contradictions:true` con `contradicts_ids:[...]` — facts cercanos pero no idénticos (sim 0.85-0.94) que pueden ser una versión vieja del mismo concepto. Si lo ves, decidí: usar update_memory sobre el id viejo (reemplazo), guardar igual con aviso (coexistencia), o preguntarle al usuario (confusión).',
        fields: [
            { name: 'content', desc: 'El hecho a recordar, en español neutro y completo (no abreviaturas). Ej: "El usuario está ahorrando para una moto". Será embeddado para búsqueda semántica.', type: 'string', default: '' },
            { name: 'kind', desc: 'fact (default) | preference | context | goal | relationship. NO uses session_summary ni __stale__ — son del sistema.', type: 'string', default: 'fact' },
            { name: 'metadata', desc: 'Metadata opcional como JSON STRINGIFICADO (no objeto). Ej: \'{"deadline":"2026-12-31"}\'. Vacío = sin metadata.', type: 'string', default: '' }
        ]
    },
    {
        name: 'recall_memory',
        description: '🔍 BUSCA EN LA MEMORIA SEMÁNTICA del usuario con scoring híbrido (similitud + recencia + uso). Usá esto cuando el mensaje tiene contexto temporal/referencial vago ("la semana pasada", "ese gasto que te dije", "como te conté", "el viaje aquel") O cuando la pregunta gana valor con contexto histórico ("Maxi está al día?", "cómo voy con mi meta de la moto?"). Devuelve los chunks más relevantes con `similarity` (semántica pura) y `final_score` (ranking final que considera también recencia y recall_count). Excluye facts marcados como __stale__ por el cron semanal. NO sirve para buscar transacciones (eso es find_transactions).',
        fields: [
            { name: 'query', desc: 'Pregunta o concepto a buscar, en lenguaje natural. Ej: "meta moto" o "transferencias a Maxi". Cuanto más específico, mejor el match.', type: 'string', default: '' },
            { name: 'k', desc: 'Cantidad de chunks a devolver (top-K)', type: 'number', default: 5 },
            { name: 'kind', desc: 'Filtro opcional por kind (fact|preference|context|goal|relationship|session_summary). Vacío = todos.', type: 'string', default: '' },
            { name: 'min_score', desc: 'Similaridad semántica mínima (0-1). Default 0.65. Subí a 0.8+ si querés solo matches muy fuertes; bajá a 0.5 si necesitás más contexto aunque menos preciso.', type: 'number', default: 0.65 }
        ]
    },
    {
        name: 'update_memory',
        description: '✏️ ACTUALIZA un hecho existente (cambia el contenido y re-embedea). Usá esto cuando un dato evoluciona pero seguís hablando del mismo hecho: "ahora ahorro 700k al mes" (antes 500k), "la meta subió a 5M" (antes 4M), "ya no soy vegetariano". Conservás el id histórico en lugar de duplicar. Pasá el `memory_id` que viene de recall_memory o list_memories.',
        fields: [
            { name: 'memory_id', desc: 'UUID del chunk a actualizar (viene de recall_memory o list_memories)', type: 'string', default: '' },
            { name: 'new_content', desc: 'Nuevo texto del hecho, completo y en español neutro. Será re-embeddado.', type: 'string', default: '' },
            { name: 'kind', desc: 'Cambiar el kind opcionalmente (fact|preference|context|goal|relationship). Vacío = mantiene el actual.', type: 'string', default: '' },
            { name: 'metadata', desc: 'Metadata extra como JSON STRINGIFICADO. Ej: \'{"new_amount":700000}\'. Se mergea con la existente. Vacío = no toca metadata.', type: 'string', default: '' }
        ]
    },
    {
        name: 'forget_memory',
        description: '🗑️ Olvida un hecho específico (soft-delete con audit log). Usá esto cuando el usuario diga "olvidate de eso", "ya no es así", "borrá lo que te dije sobre X". Pasá el `memory_id` que viene del recall_memory previo o del list_memories. El estado pre-forget queda guardado en memory_chunk_versions por si hay que rescatar después. ⚠️ Si el hecho solo CAMBIÓ (no se borra), usá update_memory en lugar de forget+remember — preserva mejor el historial. ⚠️ NO uses forget_memory sobre kind="session_summary" (los maneja el cron).',
        fields: [
            { name: 'memory_id', desc: 'UUID del chunk a olvidar (viene de recall_memory o list_memories)', type: 'string', default: '' }
        ]
    },
    {
        name: 'list_memories',
        description: '📋 Lista los hechos que tenés guardados del usuario. Para "qué recordás de mí", "qué sabés sobre mí", "borrá todo lo que te dije". Devuelve hasta `limit` chunks ordenados por recall_count y recencia. Excluye __forgotten__ y __stale__ automáticamente.',
        fields: [
            { name: 'kind', desc: 'Filtro opcional (fact|preference|context|goal|relationship|session_summary). Vacío = todos.', type: 'string', default: '' },
            { name: 'limit', desc: 'Cantidad max de items', type: 'number', default: 20 }
        ]
    }
];
