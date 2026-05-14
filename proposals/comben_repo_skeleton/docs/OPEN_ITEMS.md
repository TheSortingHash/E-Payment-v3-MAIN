# Open items

All planning-phase decisions resolved as of this commit. Items below
are deferred to the build phase (implementation details that don't
need to be decided in advance) and a few items requiring confirmation
during implementation.

## Build-phase decisions (not blockers for spec lock)

1. **Treasury bridge web app implementation details.** Mechanism
   locked in SPEC §15 (Treasury exposes a bridge web app; ComBen calls
   it via `UrlFetchApp`). To finalize during build:
   - Exact endpoint URL (deploy as web app, capture URL into
     `Config.Treasury_Bridge_Url`).
   - Shared-secret rotation policy (recommend: per-quarter rotation,
     coordinated with Admin).
   - Whether `remove` is soft-delete (preferred) or hard-delete.
   - Rate-limit posture: bridge is low-volume (likely <50 calls/day);
     no special throttling needed initially.

2. **Annex H pagination row cap.** SPEC §16.6 estimates ~25 rows per
   page based on Treasury's Annex H. Confirm exact cap when first
   generating against the actual template.

3. **Annex H name casing.** SPEC §16.3 notes Annex H typically shows
   mixed-case raw `Payee Name` rather than the FINDES-cleaned
   uppercase form. Verify during build by comparing to Treasury's
   live Annex H output.

4. **Annex H output engine.** Google Doc template vs. Sheet template
   for PDF export. SPEC §16.5 leans Sheet (closer to source data).
   Pick during build prototype.

5. **WeAccess upload monitoring.** Phase 5 is external (ComBen
   uploads to WeAccess manually). System awaits Phase 6 (CM upload)
   to confirm bank execution. If WeAccess ever exposes a programmatic
   status API, a future enhancement could poll for status — but not
   in v1.

## Resolved during planning (record only)

### Definitions and scope

- **CM definition:** Credit Memo (Landbank), not Cash Management.
  Post-release reconciliation, not pre-release.
- **HRIS master:** Treasury's existing `Payee_Database` (1,427 rows)
  is the master; no separate HRIS_Master needed.
- **Lookup key:** `HRIS_ID` (HRIS Number), not Payee Name.
- **Net-pay assumption:** ComBen receives net-pay amounts; no
  in-system deductions.
- **23 payroll types** (the v1 template's "22" was a typo).
- **COSDIF carries a batch letter** (the naming-convention sheet's
  omission was a typo).
- **Hold is PBP/COS only.** Other 21 types cannot have holds.

### Workflow and integrations

- **Upload file:** 3 columns only — `HRIS_ID`, `HRIS_Name`, `Amount`.
  No metadata sheet, no instruction sheet.
- **Batch metadata:** entered in the web app UI (Phase 1 form), not in
  the file.
- **Annex H is post-process:** generated in Phase 8 from
  bank-confirmed records, not pre-endorsement.
- **Authorizer email contains no Annex H** (timing: pre-process) but
  **includes held payee names**.
- **Payee notifications:** queued via time-driven trigger (50/min)
  for 300+ payees; per-payroll-type templates editable in
  `Payroll_Types` sheet.
- **CM exception escalation:** email admin + UI ack with reason
  (Maker).
- **Treasury bridge for Payee_Database writes** — locked option (b).
  Treasury exposes a small Apps Script web app; ComBen calls via
  `UrlFetchApp` with shared secret. See SPEC §15.
- **Sub-batch format:** `<BatchNo>_<NN>` (e.g., `04APBP26_02`).
- **OT and Differentials batch-letter mode:** Mode 1 (sequential).
  Only PBP and COS themselves use Mode 2 (quincena).
- **Disbursing officer:** Maria Monica O. Talan (Treasury). ComBen
  operates, Treasury certifies. Stored in `Config`, not hardcoded.
- **Accounting recipients:** `padillaj@`, `preciadosr@`,
  `baguim@dap.edu.ph`. Stored in `Config`.

### FINDES

- **FINDES one-row-per-payee:** no aggregation; duplicates are a hard
  error.
- **FINDES quoting:** account field is quoted in the CSV.
- **FINDES idempotency:** existing file is renamed to `.bak-<ts>`
  before overwrite, not duplicated.
- **Batch-number format:** `[mm][L][CODE][yy]` (e.g., `04BRT26`).
  Replaces Treasury's `YYYY-MM-NNN` format.
- **Batch-letter convention:** resets to `A` per `(month,
  payroll-type)`; Mode 1 sequential for most types; Mode 2
  quincena-keyed for PBP and COS only.

### Annex H

- **Annex H reference template:** committed at
  `proposals/ANNEX_H_TEMPLATE.xlsx`. SPEC §16 specifies all fields.
- BUS No. and Project Code: always blank.
- DV/Payroll No. column holds `Batch_No`.
- Nature of Payment: payroll-type label.
- Signatory: `Config.Disbursing_Officer_Name` (default
  `MARIA MONICA O. TALAN`).

### System design

- **Sanity checks:** scaled back per SPEC §9 — hard blocks on
  unknown HRIS_ID and declared-total mismatch; soft warn on 6-figure
  PBP/COS amounts (with Maker ack + note); soft warn on name mismatch
  (Admin override available); no per-type amount caps or count
  ranges.
- **Leading-zero policy:** normalize on every read and write to
  10-char zero-padded text; `@` text format on all account columns;
  Admin "Heal" tool in health panel.
- **File browser:** in-webapp Drive browser, Year/Month/Batch tree,
  filters, inline PDF preview, Drive ACL inheritance, role-gated.
- **M&E surface:** Phase 2 review table doubles as the M&E view
  (read-only after submit, columns expand with batch stage).
- **Integrity:** SHA256 on `LINE_ITEMS_<BatchNo>.json` and on
  `FINDES_<BatchNo>.csv`, stored on batch row, re-verified on read.
- **Concurrency:** `LockService` per `Batch_No`.
- **Yearly partitioning:** `Master_Payroll_Batches_<YYYY>`,
  `Audit_Log_<YYYY>`.

### Repo and code

- **Code inheritance scope:** Auth, FINDES, email templates, Annex H
  pattern, Drive helpers, LockService — port from Treasury. DV OCR,
  JEV, tax cert, BIR 2307, SDO_PCF, refund-of-payment — dropped.
- **New repo:** `TheSortingHash/E-Payment-ComBen-v1`.
- **New repo visibility: PUBLIC.** Re-confirmed during planning. No
  secrets are committed (Script Properties holds the Treasury bridge
  token); internal email addresses live in `Config`, which is a
  Sheet, not a code file.
