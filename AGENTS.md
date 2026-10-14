# AGENTS.md — LogoTool

## Project

Build FlexiTog’s offline Logo Station configurator. Customer choices must become
structured physical production specifications.

- Read the relevant sections of `FlexiTog_Logo_Station_3D_Configurator.md` before
  planning or implementation. Follow its milestones and the user’s latest instructions.
- Complete evidence-based Odoo discovery before finalizing domain and production
  schemas. Separate observed facts, assumptions and unresolved questions.

## Core constraints

- Delivered customer packages must work after unzip through `file://` in Windows
  Chrome/Edge, without installation, a server, CDN or network connection.
- Store production measurements in millimetres with explicit coordinate frames
  and calibration. Keep physical data independent of pixels and mesh transforms.
- Support different product types, variants and 0..N logo placements; avoid
  Plover-specific behavior and single-logo assumptions.
- Keep domain logic independent of React, Three.js, browser APIs and service
  providers. Version schemas and make production exports deterministic.
- Preserve original assets and evidence. Keep credentials and customer data out
  of public repositories; obtain authorization before external uploads or publishing.

## Working practices

- Follow existing conventions and keep changes scoped. Use the project’s actual
  build/test commands when available; do not invent commands for missing tooling.
- Verify meaningful domain behavior and test delivered packages directly with
  networking disabled. Do not use live Odoo calls as automated tests.
- Report changes, verification and remaining gaps accurately.
- Keep `.gitignore` scoped: when new generated artifacts, local secrets, or customer-specific data paths appear, add explicit entries; keep templates, source, and evidence tracked and review staged files before commit.

## Testing

- Unit/domain: `npm run typecheck`, `npm test` (builds first; Node-only, no
  browser). Offline inspector acceptance: `npm run test:e2e` (build + bundled
  chromium), `npm run test:e2e:chrome` / `npm run test:e2e:edge` (real branded
  browsers), `npm run test:e2e:matrix` (all three; requires Chrome AND Edge).
  See `docs/offline-testing.md` for projects, fixtures and failure artifacts.
- Playwright is the primary deterministic check: repo-local `@playwright/test`
  opens built `dist/asset-inspector.html` directly via `file://` in offline
  contexts, asserting zero console/page errors and zero HTTP(S) requests. No
  `webServer`, no fixed scratch-file or external runtime dependencies, synthetic
  fixtures only. Portable temporary output directories are allowed.
- Actual Windows Chrome/Edge over `file://` with networking disabled is the
  delivery release gate (still untested); macOS chromium/Chrome runs are
  development evidence, never Windows validation. Missing branded browsers
  must fail clearly — never skip silently or claim bundled Chromium as Chrome.
- The Browser tool (when installed) is supplementary for interactive
  inspection only, never a substitute for the suite. Obey explicit user tool
  preferences and browser security refusals (e.g. `file://` automation
  rejection): do not bypass, do not infer absence from a skill list — verify
  actual session capabilities before claiming a tool unavailable.
- Record OS/browser/version/viewport/offline/results and gaps for every
  acceptance run. Do not use live Odoo calls as automated tests.

## Coordination and delegation

- The main Codex agent in this chat coordinates the work. Use `omp` (oh-my-pi)
  to assign implementation work to a lead agent; the lead divides it among
  subagents, reviews their changes and returns an integrated result to Codex.
- Give the lead a concrete objective, acceptance criteria, authorized scope and
  expected deliverables. Check the installed OMP interface before invoking it.
- Before starting subagents, the lead assigns each a bounded task with explicit
  file/module ownership, interfaces, dependencies, required checks and completion
  criteria. Avoid overlapping write ownership; shared-file changes belong to one
  designated owner. Subagents must not expand scope or spawn further agents
  without the lead's approval.
- Workers are not alone in the workspace: preserve others' edits, coordinate
  interface changes through the lead and report blockers instead of taking over
  another worker's files. Delegate only independent tasks concurrently.
- The lead checks each result against its criteria, resolves integration issues
  and reports changed files, validation, unresolved risks and readiness to Codex.
- Codex independently reviews the integrated result, performs final validation
  and gives final approval. Only Codex commits and pushes approved changes within
  the user's authorized scope; the OMP lead and subagents must not commit or push.
- Delegation never expands Odoo access or other user authorization. Pass relevant
  project guidance and restrictions to every agent handling that work.
- When OMP can work independently, use a scheduled chat wake-up every 10, 20,
  or 30 minutes based on the expected task duration instead of continuously
  polling. Keep watching only when a concrete integration dependency, blocker,
  or time-sensitive action requires it. At each wake-up, check completion and
  blockers, continue independent review/validation when ready, and stay quiet
  while nothing actionable has changed. Disable the wake-up after the delegated
  work and Codex's final validation are complete.

## Task-specific guidance

When working on Odoo discovery, tool access or model additions, read
[docs/odoo-agent-guide.md](docs/odoo-agent-guide.md) before proceeding.
Odoo testing requires explicit approval; discovery stays within the user’s
approved scope and never executes discovered methods to test their behavior.
