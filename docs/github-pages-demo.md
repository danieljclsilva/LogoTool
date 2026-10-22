# GitHub Pages demo — one-time setup and operation

Deployment configured with user approval on 2026-10-22. The source repository
stays private; the separate public demo contains only the compiled app.

Demo: [Logo Station](https://danieljclsilva.github.io/logotool-demo/).
Updates publish after successful validation of pushes to source `main`.

## Automatic updates

Every push to `main` (plus manual `workflow_dispatch`, which publishes only
`main`-branch code) runs `.github/workflows/publish-demo.yml`:

1. **Validate + stage** (always runs): checkout, Node 24, `npm ci`,
   `npm run typecheck`, `npm test`, `npm run build:demo`, upload `dist/demo`.
2. **Publish** (runs only when the repository variable
   `DEMO_PUBLISH_ENABLED` is exactly `'true'`): downloads the staged demo,
   verifies it holds exactly `index.html` + `.nojekyll`, checks out the
   separate public repo with a repository-scoped write deploy key, copies
   ONLY those two files, commits only when changed, and pushes `main`
   normally (never force).

The destination repo serves the demo with GitHub Pages (branch `main`, root)
so visitors open the built station directly. Hosting only serves the initial
load; the app itself still works offline once downloaded. Source pushes never
touch the demo when validation fails, and ordering between queued runs is enforced by a
pre-publish freshness check: the publish job compares the run's source SHA
against current source `main` (read-only) and yields without publishing when
a newer commit has landed, so a stale queued run can never publish over a
newer deployed build. Runs are serialized; GitHub may replace a pending run
with a newer push while allowing the active run to finish.

## Public code / private project boundary

Published (public repo `danieljclsilva/logotool-demo`, branch `main`, root):

```text
index.html   # byte-identical copy of dist/station/Logo Station.html
.nojekyll    # empty marker so Pages serves the file as-is
```

Never published: `src/`, dev pages (`dist/dev/`), private assets
(`private/`), `.logo-project` files, test evidence, logs, or anything else
from this repo. The station HTML ships only the existing public-safe app +
synthetic example catalogue; operators open their real projects locally via
Choose Project / drag-and-drop — no customer data ever leaves their machine
through the demo. The contract test `tests-ts/demo-staging.test.ts` pins the
exact two-file tree and byte equality; the workflow re-verifies the tree
before every publish.

## One-time setup (completed; reference for recreation)

1. Create the **public** repo `danieljclsilva/logotool-demo` (must differ
   from this private source repo — the workflow refuses to run otherwise).
2. In the public repo: **Settings → Deploy keys → Add deploy key**, paste a
   NEW write-enabled keypair's public half (generate locally with
   `ssh-keygen`; never reuse a personal key), allow write access. This key
   can only push that one repo — it is not a general account token.
3. In THIS private repo: **Settings → Secrets and variables → Actions**:
   - secret `DEMO_DEPLOY_KEY` = the deploy key's private half;
   - variable `DEMO_REPOSITORY` = `danieljclsilva/logotool-demo`
     (the workflow defaults to this value if the variable is absent);
   - variable `DEMO_PUBLISH_ENABLED` = `true` ONLY when ready to go live.
4. In the public repo, create and push an initial `main` branch (any
   placeholder commit — the workflow needs a branch to check out), then
   **Settings → Pages → Deploy from a branch → `main` / root**.
5. Push to source `main` (or run the workflow manually): the publish job
   copies the two files, and Pages deploys them within minutes.

## Verification

- Before activation: `npm run typecheck`, `npm test` (includes the staging
  contract), literal `npm run build:demo`, then confirm `dist/demo/` holds
  exactly `index.html` + `.nojekyll` with `index.html` byte-identical to
  `dist/station/Logo Station.html`.
- After activation: push to `main`, watch the Actions run (build green,
  publish either pushed or reported “nothing to push”), then open the
  destination repo and confirm only the two files changed. Trigger a
  `workflow_dispatch` once to prove the manual path.
- Check the first Actions run and live URL after setup; local checks cannot
  prove remote credentials or Pages deployment.

## Rollback / disable

- Emergency stop: set `DEMO_PUBLISH_ENABLED` to anything but `'true'`
  (or delete the variable) — later pushes validate without publishing.
- Remove the demo: delete the public repo or disable Pages on it; rotate or
  delete the deploy key and `DEMO_DEPLOY_KEY` secret. No source changes needed.
- A bad publish is a normal two-file commit on the demo repo's `main`:
  revert it there; the next source push republishes the last good build only
  if the built output actually changed.
