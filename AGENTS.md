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

## Task-specific guidance

When working on Odoo discovery, tool access or model additions, read
[docs/odoo-agent-guide.md](docs/odoo-agent-guide.md) before proceeding.
Odoo testing requires explicit approval; discovery stays within the user’s
approved scope and never executes discovered methods to test their behavior.
