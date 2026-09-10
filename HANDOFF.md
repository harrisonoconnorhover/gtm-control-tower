# Morning Handoff

## Finished

- Added an Inbound Routing Lab to the Control Tower showroom and self-hosted navigation.
- Built the five-field practice form with WPForms-style payload keys, 32 believable fictional requests, account matching, owner preservation, and capacity routing.
- Added mapping, CRM, and notification faults; retries reconcile partial writes without duplicate contacts, assignments, or notifications.
- Added correction history, request traces, browser persistence, rep availability/capacity controls, reset, and JSON export.
- Documented the practice schema and walkthrough, with company-neutral copy throughout the lab and documentation. Fixed an existing browser download call's DOM type incompatibility.

## Try It

Run `npm run preview:public`, then open the printed local address with `/#inbound-lab`. The full application also has `/app/inbound`.

Follow `docs/inbound-routing-lab.md`: inspect a held request, correct missing enrichment, then simulate a lost CRM response and retry. Use a fresh fictional email for each new-contact failure exercise.

## Checks

- `npm test`: 83 tests passed in 17 files, including 10 inbound routing cases.
- `npm run lint` and `npx tsc --noEmit`: passed.
- Sites build helper and `npm run build:public`: passed.
- `npm run check:secrets`: passed; `git diff --check`: passed.
- Local preview returned HTTP 200.
- Copy revision: focused ESLint, public build, diff check, and company-reference searches across tracked files and the public bundle passed.

## Decisions

- CRM, notifications, enrichment, and routing policies are browser-local simulations.
- Normalized email identifies a contact; preserve active existing owners, then use region, budget, and available pool capacity.
- Keep the existing CSV and native CRM workflows separate. No new service, dependency, or credential is needed for practice.

## Remaining

- Public publication awaits Harrison's approval; the existing live sites have not been changed by this task.
- This slice does not demonstrate live vendor integrations, email delivery, or a durable shared queue.
- Browser interaction testing of the new UI has not been performed; automated behavior tests and builds passed.

## Review First

- `components/inbound-lead-lab.tsx`
- `lib/inbound-lab.ts` and `tests/inbound-lab.test.ts`
- `docs/inbound-routing-lab.md`
