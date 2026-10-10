# Portfolio credibility review

Reviewed September 24, 2026. Scope: public presentation, selected implementation paths, and focused local checks. This is not a production-readiness certification or a fresh qualification of every integration.

**Follow-up completed September 24:** Hot Potato's marketing corrections below have now been published at [its public site](https://hot-potato-32c.pages.dev/), source commit `752c38c`. Pricing/support promises and the integration logo wall were removed; the walkthrough is explicitly simulated, the rule sketch is pseudocode, and product/license links point to the application. The original findings below describe the page at review time. A real provider-workflow demonstration is still separate follow-up work.

**Video follow-up completed September 24:** The narrated slideshow and its download/navigation links were removed from Control Tower. Written sandbox results now occupy the full section; the original media is archived outside public assets. Release: `ee2618a`.

## Assessment

All three projects contain substantive software. Their public proof is uneven. The most convincing portfolio story is a small, useful operation a visitor can inspect: input, decision, result, and an honest limit. More integrations, animation, or enterprise terminology would not improve that story by itself.

| Project | Substance observed | Main credibility gap | Best next improvement |
| --- | --- | --- | --- |
| GTM Control Tower | Working browser CSV audit and calculated cleanup; inspectable routing/Apex code and dated sandbox records | Dense terminology and several different proof batches make the evidence harder to follow | Explain one operation in plain English and distinguish browser examples from historical sandbox runs |
| Hot Potato | Real routing, weighted assignment, persistent scheduling, and booking recovery implementation | The marketing site overstates what its demonstration and hosted offering prove | Correct claims and product links before promoting the marketing site |
| Pomade | Account-data grid, reusable recipes/formulas, source-linked research, reviewed notes, and explicit CRM actions | Much more functionality exists than an outside visitor can see; a research status can sound more conclusive than it is | Publish one sanitized workflow recording with inspectable input/output and clear review status |

## What changed today

[Control Tower's Sister projects section](https://gtm-control-tower.pages.dev/#sister-projects) now links to the actual [Hot Potato application](https://github.com/harrisonoconnorhover/hot-potato) and [Pomade repository](https://github.com/harrisonoconnorhover/pomade). Both cards describe concrete work and current availability. Pomade's private hosted access is explicit. Footer links repeat the destinations.

The release contains only these cards, footer links, and initial hash scrolling. It was built from the previously deployed commit `d7e63a6`, avoiding an incidental release of newer inbound-routing work. Release commit: `797ec39`; equivalent change in the development checkout: `62b4028`. Production deployment: `bf51048d-d493-4fd1-bb0f-303decbca5c5`.

## GTM Control Tower: credible, but explain the proof more simply

The public page does real local computation. `lib/messy-lead-demo.ts` calls the CSV import and repair implementation; the animated sequence displays those calculated results. The browser run produced 56 canonical rows, 44 ready and 12 held, from the bundled 64-row synthetic input. The separate sample audit also completed, reporting 32 initially ready and 32 held. Those are different stages, not contradictory outcomes.

The held records are an asset: they demonstrate judgment instead of a suspiciously perfect success story. Keep the inspectable code, local-file privacy, before/after examples, and candid description of a provider failure caught by a receipt.

Recommended small changes:

- Rename the after-state metric **Quality** to **Destination-ready**. Its 79% is a readiness calculation, not a general data-accuracy score.
- Date the Salesforce and CRM sandbox evidence beside its claims. Explain that the 64-row browser fixture, 72-row historical CRM run, three-lead routing run, and 200-lead bulk contract are separate exercises.
- Lead the Apex section with the business result: preserve valid ownership, stop stale changes, explain unresolved records. Keep terms such as Queueable and Transaction Finalizer in the technical explanation.

Suggested 90-second proof: choose the safe sample, inspect one duplicate and one hold, download its audit, then run the bundled 64-row cleanup and compare the result. The public upload tool diagnoses other CSVs; repairing those files requires the operator workspace. State explicitly that this browser demonstration does not write to a CRM. Any future recording of a sandbox workflow should be a separate, dated example.

## Hot Potato: the application is real; the marketing needs correction

The product has meaningful implementation beyond a landing page: weighted rep selection in `packages/router/src/weighted-round-robin.ts`, database reservation/locking in `packages/db/src/repository.ts`, and provider-event lookup during recovery in `apps/web/app/router-booking-recovery.ts`. Focused router and scheduling/recovery checks passed.

The [marketing site](https://hot-potato-32c.pages.dev/) creates avoidable doubt:

1. **“Try the live router” / “LIVE” mislabels a scripted example.** `hot-potato-site/app.js:1–4` contains three predetermined leads, reps and calendar slots; timers reveal the result. Label it **Interactive routing example — simulated data; no calendar or CRM calls**.
2. **Cloud at $299/month, “Most popular,” SSO/SAML and support imply an available commercial service.** This review found no verified service or purchase flow supporting those claims. Replace these panels with current self-host/development availability; describe planned hosted features as planned.
3. **The code and clone links go to the marketing repository.** Change them from `harrisonoconnorhover/HotPotato` to the application repository, `harrisonoconnorhover/hot-potato`. The site's MIT label must not imply the application is MIT; the application declares AGPL-3.0-only.
4. **Integration presentation is ahead of qualification.** The application handoff still lists Salesforce OAuth/writeback, real Gmail/Outlook client qualification, distribution review, backup/runbooks, and unique Zoom OAuth meetings as remaining work. Distinguish implemented, tested with fixtures, verified with a provider, and planned support. Label the illustrative `route.js` snippet as an example unless it becomes copyable product code.

Keep the potato identity and playful styling. The problem is the gap between claims and evidence, not personality.

Suggested proof after controlled provider qualification: one fictional inquiry → eligible rep and explanation → confirmed calendar event → CRM result → repeat the request without a duplicate booking. Until that recording is made, show actual routing output and clearly label simulated provider responses. No real booking was created in this review.

## Pomade: useful depth, insufficient accessible demonstration

The code and focused tests support actual importing, formula/recipe execution, portable recipes, research records, and account memory. Existing review UI shows editable facts with source quotes; the dated `docs/research-provider-comparison-2026-09-06.md` admits identity confusion, stale hiring evidence, and unknown per-run costs. This candor is stronger evidence than a long provider-logo list.

The private hosted URL currently leads to sign-in, so a portfolio visitor cannot inspect the workflow there. Keep it private; build public proof from synthetic data rather than widening access to solve a presentation problem. The public repository can lag local development, so date screenshots/recordings and identify their version.

One important wording issue: in `lib/web-research.ts:431–458`, a valid result with accepted citations and no explicit review request can become **Ready** with a **passed** receipt. Citation presence and a valid output shape do not establish that a fact is correct, current, or about the intended company. Prefer **Source-linked — needs review** unless the status specifically reflects human validation; explain exactly what automatic checks passed. Reviewed account memory already provides a useful pattern for deliberate confirmation.

Suggested 90-second proof: import five synthetic accounts, calculate a formula, run one recipe, inspect a source and an unknown result, deliberately approve a supported fact, and export a usable CSV. A saved research replay is fine if labeled with its original date; do not disguise it as a new live call. Accompany the recording with the input, recipe and output. Avoid claiming live qualification for provider presets tested only with synthetic responses, complete standalone packaging, or proven unattended hosted scheduling.

## Recommended order

1. Correct Hot Potato's claim, destination and availability copy. This is the largest immediate trust improvement.
2. Make one narrow Pomade workflow visible with sanitized artifacts; clarify what research statuses mean.
3. Simplify Control Tower's proof labels and date the distinct demonstrations.
4. Record one real Hot Potato routing-to-booking flow after its exact provider path is qualified. Add a marketing-site link from Control Tower when that destination is accurate.

These are bounded presentation/proof tasks. None requires a new backend, another integration, a public signup system, or invented customer outcomes.

## Fresh validation and limits

| Checkout | Command | Result |
| --- | --- | --- |
| Control Tower release | `npm test -- --run tests/messy-lead-demo.test.ts tests/crm-audit.test.ts tests/identity-resolution.test.ts tests/csv-control-tower.test.ts` | 30 passed |
| Hot Potato | `npm test --workspace @hot-potato/router` | 23 passed |
| Hot Potato | `npm test --workspace @hot-potato/web -- --run test/public-router-booking-recovery.test.ts test/public-scheduling.test.ts` | 25 passed |
| Pomade | `npm test -- --run lib/csv-import.test.ts lib/local-recipe-engine.test.ts lib/recipe-file.test.ts lib/account-memory.test.ts lib/web-research.test.ts` | 48 passed |

Total: **126 focused tests passed**. Control Tower's changed component passed ESLint, its public production build passed, and `git diff --check` passed. Browser checks covered the cleanup receipt, sample audit, card/footer destinations, keyboard navigation, desktop and 390px layouts, and initial `#salesforce-proof` / `#sister-projects` arrival. No horizontal overflow appeared on mobile. The published canonical page was read back and visually inspected.

The Hot Potato marketing animation was exercised and its source inspected. Pomade's saved account-memory screenshot was inspected, not a fresh running session. No paid research, live provider booking, new CRM writes, or private hosted Pomade workflow was run. Unit fixtures and historical receipts do not substitute for those checks. Hot Potato and Pomade were not modified; existing Hot Potato composer edits were preserved.
