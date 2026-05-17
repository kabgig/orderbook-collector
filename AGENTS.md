# SQL: always qualify table names with `public.`

Every SQL query (in `src/db/*.ts`, `src/correlation/*.ts`, ad-hoc psql, migrations, anywhere) must reference tables as `public.<table>` — never bare `<table>`.

**Why:** the production Neon project runs through a connection pooler that issues `SET search_path = ''` on every session, so unqualified names like `FROM orderbook_snapshots` fail with `relation "..." does not exist` even though the table exists. Role-level defaults (`ALTER ROLE ... SET search_path`) are overridden by the pooler. Client-side startup options (`-c search_path=...`) are blocked by Neon. Qualified names are the only approach that works on every environment.

Examples:
- ✅ `INSERT INTO public.orderbook_snapshots (...)`
- ✅ `DELETE FROM public.correlation_run_log WHERE ...`
- ✅ `INSERT INTO public.dataset_fetch_locks (dataset, last_fetch) ...`
- ❌ `INSERT INTO orderbook_snapshots ...` — will fail in production
- ❌ `SELECT * FROM correlations` — will fail in production

For dynamic table names assembled in code (e.g. the exchange-switch in `src/db/writer.ts`), prefer literal `public.` prefix in the template — `INSERT INTO public.${sql(table)}` — so the schema is fixed and only the table name comes from the variable.

Migrations live in the **freedom-vision** repo (`db/migrations/`) and are managed there via dbmate, not in this repo.
