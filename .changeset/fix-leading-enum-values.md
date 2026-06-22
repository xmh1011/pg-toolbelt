---
"@supabase/pg-delta": patch
---

Fix enum additions that insert multiple new labels before the first existing label, preserve empty enum types and empty-string enum labels during extraction and serialization, reject unsupported existing-label reordering explicitly, and restore enum security labels when replacing enums for removed labels.
