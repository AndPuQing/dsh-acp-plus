# features/ — one module per gap closed relative to the native bridge

Each file here owns exactly one capability the native `@deepseek-ai/dsh-acp`
refuses, and nothing else. A feature module is complete when:

1. Its capability is advertised from `initialize()` **only** when the matching
   `enable*` flag is on (`src/config.ts`) **and** the mounted runtime can honor
   it, so the wire never lies about support.
2. Its handler validates input before touching runtime state.
3. Its acceptance test lives in `tests/` and runs keyless.
4. `PLAN.md` records the milestone and the mechanism it consumes.

Do not grow a feature module into a second bridge. If a feature needs new
protocol methods, add the handler in `../index.ts` and keep the logic here.
