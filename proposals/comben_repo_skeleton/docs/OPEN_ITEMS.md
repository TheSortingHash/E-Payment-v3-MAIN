# Open items

Decisions deferred to the build phase, or questions still open as of
planning.

## Known open items

1. **Payee_Database write mechanism.** Treasury owns `Payee_Database`
   (locked in SPEC §0.3). ComBen's enrollment module needs to write
   into it for ADD, and for Admin-approved REMOVE / MODIFY. Options:
   (a) ComBen Apps Script opens Treasury spreadsheet via
   `SpreadsheetApp.openById` with shared edit access; (b) a bridge web
   app exposed by Treasury that ComBen calls via `UrlFetchApp`;
   (c) a queue sheet in ComBen that Treasury picks up on a trigger.
   Trade-offs: coupling, latency, auditability.
2. **Batch-letter mode for OT and Differentials.** SPEC §0.5 locks
   Mode 1 (sequential) as the default and Mode 2 (quincena-keyed) for
   PBP and COS. **Open:** do PBPOT, COSOT, COSDIF, and DIFF follow
   the quincena cadence of their parents, or revert to sequential?
2. **CM data source.** Manual upload by Maker vs. automated fetch.
3. **Accounting handoff format.** PDF + CSV bundle, or a structured
   JSON payload? Who consumes it on the Accounting side?
4. **Authorizer set.** Same authorizers as Treasury, or a different
   list for ComBen? Configured in `Config` sheet either way.
5. **Hold mechanics granularity.** Whole-batch hold only, or
   per-payee hold creating an implicit sub-batch?
6. **Repository visibility.** Currently planned as public. Re-confirm
   before first push of any code that references internal email
   addresses, authorizer names, or org-specific endpoints.

## Resolved during planning (record only)

- **CM exception escalation:** email admin + UI ack with reason (Maker).
- **FINDES one-row-per-payee:** no aggregation; duplicates are a hard
  error.
- **FINDES quoting:** account field is quoted in the CSV.
- **FINDES idempotency:** existing file is renamed to `.bak-<ts>` before
  overwrite, not duplicated.
- **Net-pay assumption:** ComBen receives net-pay amounts; no in-system
  deductions.
- **Payee_Database ownership:** Treasury owns. ComBen has an enrollment
  module that writes into it (mechanism TBD — see open item #1).
- **Batch-number format:** `[mm][L][CODE][yy]` (e.g., `04BRT26`).
  Replaces Treasury's `YYYY-MM-NNN` format.
- **Batch-letter convention:** resets to `A` per `(month, payroll-type)`;
  Mode 1 sequential for most types; Mode 2 quincena-keyed (A=1st, B=2nd,
  sub-batches append a letter) for PBP and COS.
- **COSDIF typo:** the source naming-convention sheet omitted the batch
  letter for `Differential – COS`. Confirmed typo; COSDIF takes a
  letter like every other payroll type.
