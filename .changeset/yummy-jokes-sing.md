---
"@supabase/pg-delta": patch
---

Recreate expression dependents directly during procedure replacement instead of replacing their owning table or domain.

Also preserve retained column metadata for column recreations already covered by the original diff, restore defaults on the branch-side owner of replayed owned sequences, and keep domain/table owner restores after expression and metadata replay.
