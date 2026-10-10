# Morning Handoff

## Finished

- Rebuilt the contact CSV mapper around one row per source column: original CSV header and example on the left, editable Control Tower field on the right, with match counts and clear labels.
- Added deterministic automatic matches for common CRM headers, including Work Email, Company Name, Business Phone, given/family names, and API-style capitalization. Ambiguous matches remain available for manual review.
- Added Auto-map headers to restore suggestions. Moving a destination clears its previous source; unknown columns stay visible as not imported.
- Fixed ignored fields returning after preset serialization. Explicit exclusions survive saving, reload, and import; stale or conflicting preset sources remain unmapped.
- Preserved browser CSV cleanup and native CRM qualification work documented in the existing guides.

## Try It

1. Start the updated self-hosted app and open `/app/lab`. Choose a contact CSV to preview.
2. Review **Your CSV column → Control Tower field**, including the source examples and automatic matches. Change a destination or choose **Do not import this column**, then **Validate + load**.
3. To repeat browser verification against a disposable local app, run `CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3217 npm run test:csv-mapping` after starting that app with isolated SQLite.

## Checks

- All 64 focused CSV/browser-CSV unit tests passed. TypeScript, focused ESLint, script syntax, app/public production builds, and diff checks passed.
- Desktop 1440px and mobile 390px production-browser checks passed, with five real local workspace imports and saved preset readback. Verified automatic matches, source examples, ignored-field persistence, reassignment, reset, ambiguous aliases, and stale presets.
- No JavaScript errors, external requests, or CRM calls occurred in browser verification. Screenshots were visually inspected. Private results are in `outputs/csv-mapping/`.

## Decisions

- Suggest matches from explicit header aliases, not cell contents or fuzzy guesses. Canonical names take precedence; equal candidates need review.
- Each source maps to one target. Explicit empty mappings override inferred defaults and survive JSON storage.
- This mapper loads contacts into the saved workspace. Generic browser CSV cleanup remains available for other tables and preserves all source columns.

## Remaining

- Restart or rebuild the installed operator app to use the new mapper. No hosted app was deployed in this task.
- Publishing the earlier static CSV review additions remains separate from this operator-app change.

## Review First

1. `components/self-host-console.tsx` and `lib/csv-control-tower.ts`.
2. `tests/csv-control-tower.test.ts` and `scripts/check-csv-mapping.mjs`.
3. `outputs/csv-mapping/desktop-auto-mapping.png` and [self-hosting guide](docs/self-hosting.md).
