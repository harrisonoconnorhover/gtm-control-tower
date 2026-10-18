# Check company websites before import

In the self-hosted `/app/lab`, import and save a CSV with a mapped Website column.
Enter the operator access key, then choose **Check company websites** in the import
review. This works with the existing standard and Safe Import workflows. The
public browser CSV cleaner does not run these checks.

The review groups identical normalized URLs across active, included rows. Missing
and malformed values are counted separately; skipped and merged rows are excluded.
Checks run in batches of three. **Stop after current batch** preserves completed
results; **Check unchecked websites** continues the remaining work. **Recheck all
websites** explicitly refreshes earlier observations.

Each result shows the requested and final URL, HTTP status, page title, time,
method and explanation. A normal HTTP GET runs first. Pages needing JavaScript or
otherwise inconclusive responses can use a fresh local Chromium browser. The
fallback has no access to your signed-in browser profile. If the browser is missing
or cannot finish, the explanation retains the HTTP finding and fallback limitation.

**Content retrieved** means the check found page content at that time. Blocked,
timed-out, inaccessible, invalid and uncertain websites stay visible for review.
Obvious challenge or parked pages are flagged, but those checks are heuristics,
not proof that a business is real. A blocked request does not establish that the
company's site is down. Redirects are displayed rather than changing imported URLs.

Results are stored in the existing local SQLite database, separately from workspace
revisions. Reloads and ordinary saves retain them; edited website URLs need their
own checks. Website checks do not change CRM fields, approval decisions or import
eligibility. Company identity, ICP qualification and email deliverability belong
to Pomade; this feature does not implement or invoke those capabilities.

## Runtime

The Docker image includes Chromium. For a direct Node installation, install Chrome
or Chromium and set `CONTROL_TOWER_BROWSER_EXECUTABLE_PATH` if it is not in a
standard location. Standard macOS Chrome and Linux Chromium paths are detected.
No paid API, external verification provider or model is required. Requests go from
your self-hosted machine to the supplied public websites.

Only HTTP/HTTPS on ports 80/443 is allowed. Requests and redirects use checked
public addresses; browser subrequests use the same transport. Private network
addresses, credential-bearing URLs, non-read requests, service workers and
WebSockets are blocked. Time, download size and browser resource limits bound each
check. These limits can leave complex sites needing manual review.

## Focused checks

Run `npx vitest run tests/website-checker.test.ts tests/website-network.test.ts tests/website-check-route.test.ts tests/website-check-store.test.ts`.
With local Chrome/Chromium installed, run
`WEBSITE_CHECK_BROWSER_TEST=true npx vitest run tests/website-check-browser.test.ts`
for real JavaScript rendering against fictional HTTP responses. The dedicated UI
script uses fictional website outcomes with actual disposable workspace storage;
see its header for local-server configuration. These checks do not qualify company
matching or deliverability.
