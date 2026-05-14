# Open items

Decisions deferred to the build phase, or questions still open as of
planning.

## Known open items

1. **Payee_Database bridge mechanism.** Read directly from Treasury's
   spreadsheet via `SpreadsheetApp.openById`, or maintain a mirrored
   copy in the ComBen spreadsheet synced on a trigger? Trade-off:
   freshness vs. coupling.
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
