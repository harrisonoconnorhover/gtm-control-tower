# Security

## Supported version

Security fixes are applied to the current `main` branch. This is a self-hosted
reference application, not a managed service.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for this repository rather
than opening a public issue. Include the affected route or connector, expected
impact, and a minimal reproduction. Do not include live credentials or customer
data.

## Deployment boundary

- Never commit `.env.local`, OAuth tokens, CRM access tokens, or n8n exports
  containing credential bindings.
- Keep all connectors server-side and place a hosted instance behind
  authentication and HTTPS.
- Set `CONTROL_TOWER_SYNC_KEY` before enabling production CRM writes.
- Import only workflows you have reviewed, then attach least-privilege n8n
  credentials locally.
- The public demo is designed to run without CRM or warehouse credentials.
