# E-Payment-ComBen-v1

Compensation & Benefits (ComBen) payroll disbursement system.

Sibling system to the DV-centric Treasury E-Payment system
(`TheSortingHash/E-Payment-v3-MAIN`). ComBen handles payroll-type
disbursements (one earning category per batch, one row per payee per
FINDES) and shares the same Landbank FINDES output format and name-cleaning
conventions as the Treasury system.

## Status

**Planning phase.** No app code yet. See `docs/SPEC.md` for the consolidated
specification under construction.

## Documents

- `docs/SPEC.md` — consolidated specification (workflow, data model, lifecycle, security, integrations)
- `docs/SCHEMA.md` — Google Sheets schema (sheets, columns, formats, validations)
- `docs/WEBAPP_ENDPOINTS.md` — web app surface (Maker / Admin / Bridge endpoints)
- `docs/OPEN_ITEMS.md` — undecided items deferred to build phase
- `proposals/` — artifacts (payroll template, email mockups, Drive folder tree)

## Relationship to Treasury system

ComBen reuses, by deliberate design:

- The FINDES CSV format and name-cleaning regex (see `docs/SPEC.md` §FINDES).
- The Payee_Database account-number source (read-only from ComBen's side).
- The same Google Drive root convention (`<Root>/YYYY/MM-MonthName/BATCH-<batchNo>/`).

ComBen diverges from Treasury in:

- One payroll type per batch (no DV-style mixed transactions).
- No SDO_PCF_Accounts lookup (PCF / Revolving-Fund flows are DV-only).
- Duplicate-payee within a batch is a hard error, not an expected case.
