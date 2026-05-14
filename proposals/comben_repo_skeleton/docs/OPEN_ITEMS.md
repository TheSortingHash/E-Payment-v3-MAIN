# Open items

Decisions deferred to the build phase, or questions still open as of
planning.

## Known open items

1. **Payee_Database write mechanism.** Treasury owns `Payee_Database`
   (SPEC §0.3). ComBen's enrollment module needs to write into it for
   ADD, and for Admin-approved REMOVE / MODIFY (§15). Options:
   (a) ComBen Apps Script opens Treasury spreadsheet via
   `SpreadsheetApp.openById` with shared edit access;
   (b) a bridge web app exposed by Treasury that ComBen calls via
   `UrlFetchApp`;
   (c) a queue sheet in ComBen that Treasury picks up on a trigger.
   Trade-offs: coupling, latency, auditability.

2. **Sub-batch naming format — CONTRADICTION TO RESOLVE.** Two
   formats were proposed at different points in this planning thread:
   - `<BatchNo>_<NN>` e.g. `04APBP26_02` (earlier-conversation default).
   - `<BatchNo>` + appended letter e.g. `04APBP26A` → `04APBP26AA`,
     `04APBP26AB` (most recent direct answer).
   These cannot both be true. SPEC §5.3 currently stays neutral
   pending decision.

3. **Batch-letter mode for OT and Differentials.** SPEC §0.5 locks
   Mode 1 (sequential) as the default and Mode 2 (quincena-keyed) for
   PBP and COS. **Open:** do PBPOT, COSOT, COSDIF, and DIFF follow
   the quincena cadence of their parents, or revert to sequential?

4. **Annex H visual template.** The rules are locked (§16) but the
   final layout/branding/pagination match to Treasury's current
   Annex H is TBD — needs to be done by visual comparison during build.

5. **Repository visibility for the new repo.** Currently planned as
   public. Re-confirm before first push of any code that references
   internal email addresses, authorizer names, or org-specific
   endpoints.

## Resolved during planning (record only)

- **CM definition:** Credit Memo (Landbank), not Cash Management.
  Post-release reconciliation, not pre-release.
- **CM exception escalation:** email admin + UI ack with reason
  (Maker).
- **Upload file:** 3 columns only — `HRIS_ID`, `HRIS_Name`, `Amount`.
  No metadata sheet, no instruction sheet.
- **Batch metadata:** entered in the web app UI (Phase 1 form), not in
  the file.
- **HRIS master:** Treasury's existing `Payee_Database` is the
  master; no separate HRIS_Master needed. ComBen reads via read-only
  bridge.
- **Lookup key:** `HRIS_ID` (HRIS Number), not Payee Name.
- **Annex H is post-process:** generated in Phase 8 from
  bank-confirmed records, not pre-endorsement.
- **Authorizer email contains no Annex H** (timing: pre-process) but
  **includes held payee names**.
- **Payee notifications:** queued via time-driven trigger (50/min) for
  300+ payees; per-payroll-type templates editable in `Payroll_Types`
  sheet.
- **Disbursing officer:** Maria Monica O. Talan (Treasury). ComBen
  operates, Treasury certifies. Stored in `Config`, not hardcoded.
- **Accounting recipients:** `padillaj@`, `preciadosr@`,
  `baguim@dap.edu.ph`. Stored in `Config`.
- **FINDES one-row-per-payee:** no aggregation; duplicates are a hard
  error.
- **FINDES quoting:** account field is quoted in the CSV.
- **FINDES idempotency:** existing file is renamed to `.bak-<ts>`
  before overwrite, not duplicated.
- **Net-pay assumption:** ComBen receives net-pay amounts; no
  in-system deductions.
- **Batch-number format:** `[mm][L][CODE][yy]` (e.g., `04BRT26`).
  Replaces Treasury's `YYYY-MM-NNN` format.
- **Batch-letter convention:** resets to `A` per `(month,
  payroll-type)`; Mode 1 sequential for most types; Mode 2
  quincena-keyed for PBP and COS.
- **Hold is PBP/COS only.** Other 21 types cannot have holds.
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
- **23 payroll types** (the v1 template's "22" was a typo).
- **COSDIF carries a batch letter** (the naming-convention sheet's
  omission was a typo).
- **Code inheritance scope:** Auth, FINDES, email templates, Annex H
  pattern, Drive helpers, LockService — port from Treasury. DV OCR,
  JEV, tax cert, BIR 2307, SDO_PCF, refund-of-payment — dropped.
