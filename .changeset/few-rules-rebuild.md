---
"@supabase/pg-delta": patch
---

Recreate dependent rules, triggers, check constraints, generated column expressions, aggregate definitions, publication table filters, and unchanged generated-column/materialized-view indexes around function replacements and column rewrites so PostgreSQL can apply the generated migration without dependency errors or losing dependent metadata. Column rewrites now also restore CLUSTER markers for rebuilt table and materialized-view indexes, drop generated-column indexes before resetting incompatible expressions, and avoid PostgreSQL's forbidden `USING` clause when altering generated column types.
