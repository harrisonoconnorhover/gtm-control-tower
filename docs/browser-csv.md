# Clean a CSV in your browser

Open **[Clean a CSV](https://gtm-control-tower.pages.dev/#clean-csv)** to upload,
review, and download a file without installation, an account, or a CRM connection.
The existing `#audit` link opens the same workflow.

No email, name, or record ID column is required. Company exports, deal exports,
and other tables open with every original column and row available.

## Upload, review, download

1. Load the sample or choose a CSV with a header row, up to 10 MB and 10,000 data
   rows. Original headers, column order, custom columns, and row order are retained.
2. Check the selected email column and columns to trim. Preview the proposed
   changes and apply them explicitly. Common name, company, and job-title columns
   are selected for whitespace cleanup by default. If no email or cleanup columns
   are recognized, the formatting rules open automatically so you can choose.
3. Review empty rows and exact repeated rows, plus missing, malformed, or repeated
   emails when an email column is selected. Open a row to edit its cells or compare
   it with related rows, including rows on other pages. Inspect differing values
   or show every column before deciding whether to exclude a row.
4. Download the cleaned CSV. Every included row is exported, even if it still has
   a warning. Current row edits are included without a separate **Save row** click;
   suggested formatting changes still need to be applied explicitly. For example,
   `contacts.csv` becomes `contacts-cleaned.csv` in your browser's Downloads list.

## Editing and review

Your edits stay when you switch rows, close the row editor, download, or apply
another action such as formatting or exclusion. **Save row** updates the review
notes and related-row comparison immediately. **Discard edits** returns the open
row to its last saved values.

**Undo** first discards any unsaved edits in the open row. After that, it can undo
the last ten saved actions, including formatting, column choices, and exclusions.
Opening another CSV starts a new history. Excluded rows remain available in the
**Excluded** view and can be restored; no rows are merged or removed automatically.

For wide files, **Find a column** narrows the editor by column name or number.
**Previous row** and **Next row** follow your current row filter and search, keeping
pending edits as you move. Duplicate or unnamed columns show their source position;
exported headers stay unchanged.

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
You can visit the site's overview or Inbound Routing Lab and return to the cleaner
in the same tab without losing your file or pending edits. Download before
refreshing, closing the tab, opening another file, or navigating to another site.
The download is your saved copy; the browser session is not permanent storage.

Downloads use UTF-8 with an encoding marker (BOM), which helps Excel open accented
names correctly without an import wizard; see [Microsoft's guidance](https://support.microsoft.com/en-gb/excel/opening-csv-utf-8-files-correctly-in-excel).
CSV tools that do not recognize this marker may treat it as part of the first
header. The cleaner removes it when reopening a downloaded file.

Formula-like cells receive a leading apostrophe on export so spreadsheet software
does not treat them as formulas. The download area shows how many cells will be
protected. This is an export change; the in-memory values remain unchanged.
Spreadsheet software may still convert dates, numbers, or leading-zero IDs when
opening a CSV. Import columns as text in your spreadsheet when those exact values
matter.

For saved review history, connector receipts, or direct CRM operations, use the
separate [self-hosted operator workspace](self-hosting.md).
