# Morning Handoff

## Finished

- Consolidated Safe Import, HubSpot/Salesforce Watchdog, the Operations Inbox, Slack notifications, inbound routing, duplicate audit and Salesforce/Hollis intake work for main.
- Preserved both Git histories and all existing main functionality. Resolved 18 conflicts caused by mirrored commits using the verified newer source.
- Added explicit TypeScript checking to CI, excluded generated outputs from lint, clarified historical evidence and surfaced Safe Import in the README.
- Updated vulnerable dependencies and replaced two build tools' unpatched glob dependency with a small scoped, tested tinyglobby adapter. The existing audit gate remains intact.

## Try It

1. Follow the [README](README.md): `docker compose up --build` starts the persistent SQLite application.
2. Open `/app/work` for CSV requests and findings, `/app/lab` for saved Safe Import reviews, or `/app/watchdog` for provider monitoring and triage.
3. Configure your own CRM connections and operator key. Follow [Slack setup](docs/slack-notifications.md) for the channel webhook and private app URL; run `npm run watchdog` for background checks and delivery.

## Checks

- Full suite: 650 tests across 52 files passed. TypeScript, lint, doctor, application/public builds, Compose validation and diff checks passed.
- A separate clean `npm ci`, dependency resolution and real Next/Vite consumer tests passed. The dependency audit passes its high/critical threshold; production-only audit reports zero vulnerabilities.
- Secret scanning passed before publication. GitHub CI additionally checks the credential-free Docker installation, SQLite restart persistence and undo; consult the pull request check for that run's result. The local Docker daemon was unavailable.
- The public output remains static. No CRM writes, Slack messages, Salesforce metadata deployment or hosted operator deployment occurred during integration.

## Decisions

- Keep a normal merge with both histories; retain the unrelated author-rewrite backup separately. Every completed feature tip is included.
- Use the existing self-hosted SQLite runtime. Merging source does not qualify the whole-file D1 executor.
- The glob adapter supports the two existing build-tool consumers only; remove it when upstream dependencies replace their vulnerable chain. See [decisions](docs/decisions.md).

## Remaining

- Four moderate development-tool audit findings remain in Drizzle's nested esbuild chain; production dependencies are clear.
- Slack requires local destination configuration. Native Salesforce automatic writes and hosted Safe Import execution remain unqualified.
- Polling can miss intermediate CRM changes; team roles, Slack approvals and automatic OAuth refresh remain outside the completed slice.

## Review First

- [README](README.md), [Safe Import](docs/safe-import.md), and [Operations Inbox](docs/operations-inbox.md).
- `.github/workflows/ci.yml` and the pull request's CI results, including credential-free Docker startup and persistence checks.
- `vendor/fast-glob-compat`, its consumer tests, and the dependency lockfile.
