# Clean a CSV in your browser

Open **[Clean a CSV](https://gtm-control-tower.pages.dev/#clean-csv)** to upload,
review, and download a file without installation, an account, or a CRM connection.
The existing `#audit` link opens the same workflow.

No email, name, or record ID column is required. Company exports, deal exports,
and other tables open with every original column and row available. If you see
the older “Add an email or full_name column” error, refresh the page or reopen
the link above to load the current workspace.

## Upload, review, download

1. Load the sample or choose a CSV with a header row, up to 10 MB and 10,000 data
   rows. Original headers, column order, custom columns, and row order are retained.
2. Check the selected email column and columns to trim. Preview the proposed
   changes and apply them explicitly. Common name, company, and job-title columns
   are selected for whitespace cleanup by default.
3. Review empty rows and exact repeated rows, plus missing, malformed, or repeated
   emails when an email column is selected. Edit individual cells as needed;
   explicitly exclude a row only when you want to omit it. You can restore excluded
   rows and undo your last edit.
4. Download the cleaned CSV. Every included row is exported, even if it still has
   a warning. Download before refreshing or leaving the page.

## What cleanup changes

Whitespace cleanup trims the beginning and end of selected cells. Email cleanup
trims surrounding whitespace and normalizes the domain to lowercase ASCII using
IDNA for internationalized domains. It preserves the email's local-part case,
plus tags, and dots. Review the before/after values before applying changes.

Email warnings invite review; they do not establish that two rows are the same
person. The cleaner never merges or removes rows automatically and does not guess
owners, lifecycle stages, or your business rules. The site's separate synthetic
cleanup demonstrates those policies on fictional records only.

Repeated-row checks compare every current cell exactly, including spaces and
custom columns. Empty rows contain only blank or whitespace-only cells. These
checks work without an email column; turning email checks off leaves them active.
Editing, excluding, restoring, and Undo recalculate review notes. A repeated row
may be intentional, so it remains in the download unless you exclude it.

## Privacy and export

Your source file and edits stay in the current tab's memory. The CSV workflow
does not upload source rows, call an operator API, or save them in browser storage.
Refreshing, closing, or leaving the page loses the session. A download saves the
included data to your computer; it is the way to keep your work.

Formula-like cells receive a leading apostrophe on export so spreadsheet software
does not treat them as formulas. The download area shows how many cells will be
protected. This is an export change; the in-memory values remain unchanged.
Spreadsheet software may still convert dates, numbers, or leading-zero IDs when
opening a CSV. Import columns as text in your spreadsheet when those exact values
matter.

For saved review history, connector receipts, or direct CRM operations, use the
separate [self-hosted operator workspace](self-hosting.md).
