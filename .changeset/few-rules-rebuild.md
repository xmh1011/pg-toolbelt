---
"@supabase/pg-delta": patch
---

Recreate dependent rules, triggers, check constraints, generated column expressions, aggregate definitions, publication table filters, and unchanged generated-column/materialized-view indexes around function replacements and column rewrites so PostgreSQL can apply the generated migration without dependency errors or losing dependent metadata. Column rewrites now also restore CLUSTER markers for rebuilt table and materialized-view indexes, drop generated-column indexes before resetting incompatible expressions, and avoid PostgreSQL's forbidden `USING` clause when altering generated column types.

Generated columns on PostgreSQL 17+ now use the drop/add rebuild path when the target type has no assignment or implicit cast from the existing stored type, and aggregate signature changes are seeded as replacement roots so dependent rewrite objects are dropped before the old aggregate signature.

Domain CHECK constraints and defaults that depend on routines rebuilt from column invalidations are now dropped and restored around the routine replacement, and PostgreSQL 17+ generated columns are rebuilt when either side of the type change uses a domain type that could reject temporary NULL resets.
