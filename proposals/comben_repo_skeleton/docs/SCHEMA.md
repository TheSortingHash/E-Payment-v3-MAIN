# ComBen — Sheets schema

> **Status:** Stub. To be filled during SPEC §2 / §8 walkthrough.

For each sheet:

- Sheet name
- Frozen rows
- Header row (column letter → header text)
- Per-column: data type, number format, data validation, conditional
  formatting (if any)
- Protected ranges

## Sheets to define

- `Master_Payroll_List` (hot)
- `Archive_Payroll_List` (cold)
- `Payee_Database` (bridge — read pattern TBD)
- `Config`
- `Audit_Log`
- `SDO_PCF_Accounts` — **NOT IN COMBEN** (DV-only, listed here only to
  explicitly call out its absence)

**[TO BE DRAFTED]**
