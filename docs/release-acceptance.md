# Release acceptance — Windows Chrome + Edge offline gate

The delivery release gate is: **actual Windows Google Chrome and Microsoft Edge,
opening delivered packages through `file://` with networking disabled.**
That gate is **UNTESTED** until the run below passes on a real Windows host and
its report folder is filed as the record.

Related documents:

- `docs/offline-testing.md` — development evidence (macOS) and suite layout.
- `docs/operator-pilot-checklist.md` — physical/pilot checks no script can cover.
- `scripts/run-windows-acceptance.ps1` — the runnable operator script for this gate.

## Policies (non-negotiable)

1. **No silent skips.** A branded scope that cannot run (browser missing,
   networking still on) is recorded as FAIL or UNTESTED with the reason stated.
   It is never omitted from the report and never counted as passing.
2. **Bundled Chromium is never branded Chrome.** `test:e2e` (project
   `chromium`) is a useful smoke signal only. Only `test:e2e:chrome` (channel
   `chrome`) counts for the Chrome gate, and only `test:e2e:edge` (channel
   `msedge`) counts for the Edge gate.
3. **macOS runs are development evidence only.** Any Chromium/Chrome result from
   macOS — however green — is never Windows validation.
4. **Offline means the host is offline.** The specs run with Playwright
   `offline: true` contexts and assert zero HTTP(S) requests per test, but the
   gate additionally requires the Windows host itself to have networking disabled
   (Airplane mode, Wi-Fi off, Ethernet unplugged) for the whole run.
5. **No fabricated baselines.** Expected counts below are macOS recordings, not
   predictions. A Windows run reports its own numbers; mismatches are findings,
   not failures to hide.

## Baselines (macOS development evidence — NOT Windows results)

Recorded full-matrix evidence, macOS Darwin 27.2.0 arm64, Node 26.10.0:

| Scope | macOS evidence (recorded 2026-10-18) | Windows Chrome | Windows Edge |
| --- | --- | --- | --- |
| `npm run typecheck` | Pass | UNTESTED | n/a |
| `npm test` (Node-only, builds first) | 485/485 independently verified | UNTESTED | n/a |
| `npm run test:e2e` (bundled Chromium 156.0.8078.4) | 131/131 independently verified | UNTESTED (smoke only, never the branded gate) | UNTESTED (smoke only) |
| `npm run test:e2e:chrome` (installed Chrome 155.0.8059.80; independent full run 128/131, traced rerun of the three failed cases 3/3; full gate incomplete — see `docs/offline-testing.md`) | development evidence only | UNTESTED | n/a |
| `npm run test:e2e:edge` | local launch check fails: Edge absent; functional acceptance untested | n/a | UNTESTED |

Suite inventory verified against source 2026-10-18: 23 spec files under `e2e/`
(131 cases), 32 test files under `tests-ts/` (485 tests), plus 18 repo Python
tests, three Playwright projects (`chromium`, `chrome`, `msedge`), no
`webServer`, viewports 1280×900 plus 390×844 covered inside the specs. If the
Windows run reports different counts, file it as a finding — do not edit the
specs to match.

## Step-by-step (Windows operator)

### 1. Prepare (network ON is fine here)

1. Unzip the delivered package (or clone the repo) to a local folder, e.g.
   `C:\LogoTool`, and open PowerShell in the repo root.
2. Install Node.js **>= 22.18.0** (`package.json` `engines`). Check with
   `node -v`.
3. Install dependencies: `npm ci`.
4. One-time browser setup (may need network):
   `npx playwright install chromium` — this covers the bundled-`chromium`
   smoke project only. Separately confirm real **Google Chrome** and
   **Microsoft Edge** are installed.
5. Build once while still online if you want to separate build from test:
   `npm run build`. (The `test*` scripts rebuild anyway.)

### 2. Go offline

1. Turn on **Airplane mode**, switch **Wi-Fi off**, and **unplug Ethernet**.
2. Confirm no VPN or tethered connection is active.

### 3. Run the acceptance script

From the repo root, with networking still disabled:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-windows-acceptance.ps1 -NetworkDisabled
```

The script runs, in order: `npm run typecheck`, `npm test`,
`npm run test:e2e -- --workers=1`, then the branded projects
(`test:e2e:chrome`, `test:e2e:edge`). Single-worker runs are deliberate:
parallel workers have triggered timeouts in browser-process-heavy drag specs.

Without `-NetworkDisabled` the script runs only the offline-safe smoke scopes
and records both branded scopes as UNTESTED (exit 2). A branded browser that is
missing makes its scope a hard FAIL (exit 1) — install the browser and re-run.
Each Playwright scope keeps its own artifacts (`artifacts/<scope>` output dir
plus `artifacts/<scope>-report` HTML report) because every Playwright
invocation would otherwise clean the previous scope's evidence; the report dir
also holds per-scope logs, `environment.txt` and `summary.txt`.

### 4. Open the delivered files manually (script does not do this)

Automated specs open built/extracted HTML themselves, but the operator must also
open each delivery format directly, offline, in **both** branded browsers:

1. `dist/station/Logo Station.html` — via `file://` (double-click or paste the
   `file:///C:/...` URL). Walk the guided flow once per
   `docs/internal-builder.md` on synthetic data.
2. Hybrid ZIP: unzip `dist/dev/*.zip` to a folder **with spaces in its name**,
   open its `OPEN_LOGO_CONFIGURATOR.html` via `file://`.
3. Self-contained HTML: copy `dist/dev/synthetic-customer-self-contained.html`
   alone into an empty folder and open it via `file://` — it must load with no
   siblings.
4. Dev-only engineering pages `dist/dev/customer-return-review.html` and
   `dist/dev/asset-inspector.html` — open via `file://` and confirm they render
   with no error overlay. These are developer utilities, not the shipped
   station; the release delivers only `dist/station/`.

For each file and each browser record: renders / error overlay / console errors
(operator: press `Ctrl+Shift+J`, confirm zero errors) / any network activity.
Anything unexpected is a finding, even if the scripted suite is green.

### 5. File the report

The script writes a timestamped folder (default
`%TEMP%\logotool-acceptance-<timestamp>\`) containing:

- `environment.txt` — OS / release / architecture, Node/npm versions, Chrome
  and Edge paths + file versions, network-confirmation flag, viewports and
  offline-enforcement note.
- `typecheck.log`, `npm-test.log`, `e2e-chromium.log`, `e2e-chrome.log`,
  `e2e-msedge.log` — full per-scope logs.
- `summary.txt` — per-scope PASS / FAIL / UNTESTED lines.

Copy that folder to the release record location and paste its summary into the
release note with:

- OS / browser / version / viewport / offline state / results for every scope.
- Which scopes are UNTESTED and why.
- Gaps: this gate covers scripted synthetic journeys only. Physical
  calibration, curved-surface rendering, production approval and operator
  usability remain separate — see `docs/operator-pilot-checklist.md`.

## Reading the exit code

- `0` — every executed scope passed on this host; nothing UNTESTED.
- `1` — at least one FAIL (including a missing branded browser for its scope).
- `2` — no FAIL, but something is UNTESTED (e.g. `-NetworkDisabled` omitted).

Exit 0 on Windows still leaves the pilot/physical gates in
`docs/operator-pilot-checklist.md` UNTESTED. Do not claim production readiness
from this gate alone.
