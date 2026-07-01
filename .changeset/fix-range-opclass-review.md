---
"@supabase/pg-topo": patch
---

Fix range subtype default opclass diagnostics for built-in and domain subtypes, schema-qualified array types that shadow built-ins, and external default opclass provider subtype matching. Explicit range opclass dependencies now include subtype constraints, unqualified built-in operator family names resolve through pg_catalog when no local family exists, and pg_catalog hash support routines are recognized without local producers. Operator comments now preserve concrete argument signatures, `NONE` opclass support operator slots stay unary-only, annotated operator class providers satisfy omitted range opclass dependencies, and external range providers no longer invent default multirange types without an explicit multirange provider.

Also require omitted range subtype opclass providers to be `DEFAULT`, preserve explicit public built-in type references when deduping implicit refs, avoid treating set-returning routines as scalar callback providers, ignore implicit built-in type refs in self-reference checks, require non-ordering opclass search operators to resolve to boolean-returning operators when a local same-signature shadow exists, and require btree support function 5 options callbacks to return `void`.
