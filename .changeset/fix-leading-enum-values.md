---
"@supabase/pg-delta": patch
---

Fix enum additions that insert multiple new labels before the first existing label, and preserve empty enum types and empty-string enum labels during extraction and serialization.
