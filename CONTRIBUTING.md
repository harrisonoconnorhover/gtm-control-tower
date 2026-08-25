# Contributing

Contributions that improve portability, data-quality controls, connector
reconciliation, or the demo experience are welcome.

## Local workflow

```bash
npm ci
npm run setup
npm test
npm run lint
npm run build
```

Keep examples synthetic. Do not commit exported n8n credential bindings,
personal CRM IDs, access tokens, `.env.local`, or generated files under
`.runtime`. Add the smallest relevant test for behavior changes and describe
any connector-side assumptions in the pull request.

By contributing, you agree that your contribution is licensed under the MIT
License.
