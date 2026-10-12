# Test browser control on synthetic pages

This lab measures T3's managed Chrome mechanics without opening real accounts.
It calls the production `computer_*` handlers, `ChromeAutomation` service and
Playwright page adapter. Only browser launch is injected to use headless Chrome.
The fixture server binds to loopback on an available port. The browser context
blocks requests outside that fixture origin.

## Run the measurements

Use the repository's supported Node version and installed dependencies. Run from
`apps/server` in PowerShell:

```powershell
$env:T3_BROWSER_LAB = '1'
$env:T3_BROWSER_LAB_RUNS = '20'
$env:T3_BROWSER_LAB_EVIDENCE = '<private evidence directory>'
..\..\node_modules\.bin\vp.cmd test run scripts/browser-control-lab/reliability.test.ts
```

The suite is skipped unless `T3_BROWSER_LAB=1`. Runs must be an integer between
1 and 100. If the evidence directory is omitted, the lab creates a temporary
directory. It uses Chrome discovered by T3, not a downloaded browser. Each run
creates a disposable T3 home and profile, closes its browser and fixture server,
and removes the temporary home through the test scope.

`results.json` retains every measurement, synthetic save payload, launch details
and failure probe. The first run also captures a screenshot of each workflow.
Each timing includes navigation, dynamic-list readiness, fresh snapshots,
interactions, save receipt and rendered readback. Browser startup is separate.
It does not include model reasoning, network MCP transport or T3 client latency.

## Inspect the pages

To inspect the synthetic pages manually, run the following command from
`apps/server`. The command prints its loopback URL and stays open until Ctrl+C.
Do not register this as a background service.

```powershell
node scripts/browser-control-lab/fixture-server.ts
```

Open the printed URL in a disposable browser profile. The navigation links open
the bank-feed, bill and timesheet fixtures. All records are synthetic.

The fixtures exercise rotating and replaced payment rows, near-duplicate
payments, a cancelable HTML confirmation dialog, duplicate input IDs, delayed
time-card fields and 0.5 to 1.5 second saves. The timesheet has seven days,
including explicit zero-hour weekends.

## Read the results correctly

Success requires one exact synthetic save receipt and a visible `Saved` status.
A completed click is not a completed business workflow. The driver takes a new
snapshot before each action and matches observed refs by their visible names.
Fixture-only readiness waits and mutation stimuli are marked in the test.

Separate probes repeat three cases five times each:

- Reuse a ref after another action consumed the snapshot.
- Act on a ref after a payment-list refresh detached its element.
- Click a control that opens native JavaScript `confirm`, instead of an HTML
  dialog. T3 exposes no managed-Chrome dialog acceptance tool. Playwright's
  default dismissal leaves this fixture unsaved even when the click completes.

The first two cases must reject stale targets. The third must show cancellation
and zero saves. These probes are not folded into the successful HTML-dialog
workflow rate.

These are deterministic mechanical measurements, not model success rates, real
QBO or Harvest acceptance, desktop Preview acceptance, or proof that a live
T3 thread has attached browser tools. Tool annotations and the granted synthetic
capability do not prove a provider's approval behavior.
