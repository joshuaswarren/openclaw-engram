---
"@remnic/cli": patch
"@remnic/core": patch
---

Add `remnic openclaw migrate-engram` for legacy `@joshuaswarren/openclaw-engram`
operators moving to `@remnic/plugin-openclaw`, including legacy extension backup,
canonical `openclaw-remnic` config migration, and updated migration docs.

Also align OpenAI GPT-5 chat-completions compatibility by using
`max_completion_tokens` and omitting `temperature` for native OpenAI `gpt-5*`
models.
