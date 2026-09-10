# Anti-slop provenance

- **Source:** bundled `install-anti-slop` skill snapshot at
  `.agents/skills/install-anti-slop/assets/anti-slop`.
- **Snapshot revision:** `12cd4aa472656c5d251209be31bc3acf334bc2a9`, the Git
  commit containing the copied skill assets.
- **Installed entry points:**
  - `tools/oxlint/anti-slop/index.ts` (`anti-slop`)
  - `tools/oxlint/anti-slop/effect/index.ts` (`anti-slop-effect`)
- **Configuration:** `oxlint.config.ts` enables every generic rule and the
  opt-in Effect rule at `error`; the Effect rule is enabled because `effect` is
  a direct dependency in the root `package.json`.
- **Dependencies:** `oxlint@1.82.0` and `@oxlint/plugins@1.82.0`, both exact
  development dependencies.
- **Intentional deviations:** none.
