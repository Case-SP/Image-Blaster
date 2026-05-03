# References

Drop reference images into the per-style subfolder for each composition:

- `product-shot/` — clean isolated studio examples
- `in-situ/` — environmental, lived-in examples
- `sketch/` — pen-on-paper notebook page examples

The cartridge loader tags each reference with its parent folder name. The orchestrator filters references per-shot at render time, so the `sketch` shot only ever sees `sketch/` references (plus any untagged references at the root if you add them).

JPG, PNG, and WEBP are accepted. Up to 64 total references are loaded; up to 8 reach fal per render (REF_BUDGET). Filenames sort alphabetically — prefix with `01-`, `02-` if you want a stable order.

Untagged references placed directly in `references/` are used as a fallback when a composition has no style-scoped references.
