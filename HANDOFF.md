# Morning Handoff

## Finished

- Kept browser CSV files and pending edits through row changes, downloads, editor closing, and navigation within the public site.
- Added related-row comparisons across pages, with custom columns, differences-first review, and explicit exclusion/Undo.
- Made mobile Review actions visible without swiping. Restored keyboard focus after closing an editor and moved pagination to the start of the next page.
- Distinguished repeated and unnamed source columns without changing exported headers; retained empty final rows in single-column exports.
- Opened formatting choices automatically for generic files with no recognized cleanup columns.

## Try It

1. Run `npm run preview:public -- --port 4175` and open `http://127.0.0.1:4175/#clean-csv`.
2. Load the sample, apply formatting, and review row 1 to compare its related row. Edit a cell, switch rows, and download without a separate Save click.
3. Visit the overview and return: the file stays open. Download before refreshing or closing the tab.

## Checks

- All 801 tests passed. TypeScript, full ESLint, operator production build, and public production build passed.
- Production-browser upload/edit/download, related-row comparison, and keyboard checks passed at 1440px and 390px. No CSV-processing HTTP requests or source-data storage occurred.
- A 10,000-row, 100-column file opened, applied 30,000 formatting changes, and downloaded every source column and included row correctly.
- Downloaded UTF-8 bytes include an Excel-compatible BOM; accented names and first headers survive reopening. Diff checks passed.

## Decisions

- Retain the file in tab memory across site views; keep browser storage and server uploads out of CSV processing.
- Save pending row edits during ordinary actions; explicit Discard and bounded Undo remain available.
- Compare related source rows without choosing a winner, merging, or removing rows automatically.

## Remaining

- These refinements are verified locally; public deployment is pending.
- Refreshing, closing the tab, or leaving the site still loses the session unless the user downloads it.

## Review First

1. `components/browser-csv-workspace.tsx` and `components/browser-csv-related-rows.tsx`.
2. `lib/browser-csv.ts` and browser regression scripts.
3. `docs/browser-csv.md` and `outputs/browser-csv-related/` screenshots.
