# ComBen — Sheets schema

> **Status:** LOCKED. Implements SPEC §2 (data model) and §8 (schema
> bootstrap). `setupComBenSchema()` materializes this document.

This file is the authoritative reference for every sheet, column,
number format, validation, frozen row count, and protected range in
the ComBen-owned spreadsheet. `setupComBenSchema()` creates whatever
is missing without overwriting existing data, and `verifyComBenSchema()`
audits an existing spreadsheet against this document.

Conventions used throughout:
- `@` = text format (preserves leading zeros).
- `#,##0.00` = PHP amount format.
- `yyyy-mm-dd HH:mm:ss` = ISO-like timestamp format.
- "Frozen rows: 1" means the header row is frozen; data starts at row 2.
- Sheet names containing `<YYYY>` are yearly-partitioned; one sheet per
  fiscal year. The bootstrap creates the current year on first run and
  on January 1 of subsequent years.

---

## Sheet index

| # | Sheet | Type | Pruning |
|---|---|---|---|
| 1 | `Master_Payroll_Batches_<YYYY>` | Hot — operational head | Yearly partition; previous year becomes read-only |
| 2 | `Held_Records_Open` | Hot — open holds only | Row removed on release/cancel; archived to parent batch JSON |
| 3 | `Payroll_Types` | Hot — config | None (manually managed) |
| 4 | `Authorizers` | Hot — config | None (manually managed) |
| 5 | `User_Database` | Hot — auth | None (manually managed) |
| 6 | `Config` | Hot — config | None (manually managed) |
| 7 | `Outbound_Email_Queue` | Hot — transient | Row removed after `Sent` confirmed |
| 8 | `HRIS_Pending_Changes` | Hot — transient | Row archived after decision; kept for one year then exported to JSONL |
| 9 | `Audit_Log_<YYYY>` | Hot — append-only | Yearly partition; previous year exported to `_archive/Audit_Log_<YYYY>.jsonl` and sheet cleared |
| 10 | `_Setup_Log` | Meta — bootstrap audit | None |

`Payee_Database` is **not** in this list — it lives in Treasury's
spreadsheet (SPEC §0.3). Its shape is documented in §A below for
reference only; ComBen does not create or modify it directly.

---

## 1. `Master_Payroll_Batches_<YYYY>`

One row per batch (parent or sub-batch). Head record only; line items
live in Drive (SPEC §2.3).

- **Frozen rows:** 1
- **Frozen columns:** 1 (`Batch_No`)
- **Protected range:** entire sheet for non-Admin roles after row is
  in any state other than `Draft`. (Admin can still edit for ops
  recovery; mutation logged.)

### Columns

| Col | Header | Type | Format | Validation | Notes |
|---|---|---|---|---|---|
| A | `Batch_No` | text | `@` | regex `^\d{2}[A-Z]+[A-Z]{2,5}\d{2}(_\d{2})?$` | Primary key. `[mm][L][CODE][yy]` or with `_NN` sub-batch suffix. |
| B | `Parent_Batch_No` | text | `@` | regex `^\d{2}[A-Z]+[A-Z]{2,5}\d{2}$` or blank | Set only on sub-batches. Blank for parents. |
| C | `Payroll_Type` | text | — | Dropdown sourced from `Payroll_Types.A2:A` | One of 23 types. |
| D | `Period_Covered` | text | — | — | Free text, e.g. `April 1-15, 2026`. |
| E | `Status` | text | — | Dropdown: `Draft`, `Pending Approval`, `Bank Processing`, `Bank-Confirmed`, `Notifications Sent`, `Annex H Generated`, `Forwarded to Accounting`, `Closed`, `Partially Released - Hold Pending`, `Failed - Bank Mismatch`, `Cancelled` | State machine (SPEC §1). |
| F | `Active_Count` | integer | `0` | `>= 0` | Count of ACTIVE rows in line-items JSON. |
| G | `Hold_Count` | integer | `0` | `>= 0` | Count of HOLD rows. |
| H | `Total_Released` | currency | `#,##0.00` | `>= 0` | Sum of ACTIVE amounts (PHP). |
| I | `Total_Held` | currency | `#,##0.00` | `>= 0` | Sum of HOLD amounts (PHP). |
| J | `Uploader_Name` | text | — | — | Maker full name. |
| K | `Uploader_Email` | text | — | regex email | Maker DAP email. |
| L | `Created_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | UTC+8. |
| M | `Line_Items_File_ID` | text | `@` | — | Drive file ID of `LINE_ITEMS_<BatchNo>.json`. |
| N | `Line_Items_SHA256` | text | `@` | 64-hex | Integrity hash (SPEC §14.5). |
| O | `Supporting_Docs_Folder_ID` | text | `@` | — | Drive folder ID of `<Batch>/supporting_docs/`. |
| P | `FINDES_File_ID` | text | `@` | — | Drive file ID. |
| Q | `FINDES_SHA256` | text | `@` | 64-hex | Integrity hash. |
| R | `CM_File_ID` | text | `@` | — | Drive file ID. Set in Phase 6. |
| S | `CM_TRN` | text | `@` | — | Bank Transaction Reference Number. |
| T | `Bank_TX_DateTime` | datetime | `yyyy-mm-dd HH:mm:ss` | — | From CM. |
| U | `Annex_H_File_ID` | text | `@` | — | Drive file ID. Set in Phase 8. |
| V | `Annex_H_Report_No` | text | `@` | regex `^\d{4}-\d{2}-\d{3}$` | e.g. `2025-06-010`. |
| W | `Handoff_Email_Sent_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | Phase 9. |
| X | `Closed_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | Set when Accounting confirms receipt. |
| Y | `Notes` | text | — | — | Free-form. |

### Conditional formatting

- `Status = Failed - Bank Mismatch` → row background `#FCE8E6` (red tint).
- `Status = Closed` → row background `#E6F4EA` (green tint).
- `Status = Partially Released - Hold Pending` → row background `#FEF7E0` (yellow tint).

---

## 2. `Held_Records_Open`

Currently-open HOLD rows across all active batches. Small (estimated
< 100 rows at any time). Source of truth for hold management is each
batch's line-items JSON; this sheet is a fast index.

- **Frozen rows:** 1
- **Frozen columns:** 0
- **Protected range:** Maker read-only after row is in `RELEASED` —
  but normally the row is deleted on release, so this rarely matters.

### Columns

| Col | Header | Type | Format | Validation | Notes |
|---|---|---|---|---|---|
| A | `Batch_No` | text | `@` | — | Parent batch. |
| B | `Row_Index` | integer | `0` | `>= 0` | Index into line-items JSON array. |
| C | `HRIS_ID` | text | `@` | regex `^\d{6}$` | 6-digit, padded. |
| D | `HRIS_Name_Master` | text | — | — | From Payee_Database. |
| E | `Amount_PHP` | currency | `#,##0.00` | `>= 0` | |
| F | `Hold_Reason` | text | — | required (non-empty) | |
| G | `Held_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | |
| H | `Held_By` | text | — | regex email | Maker. |
| I | `Status` | text | — | Dropdown: `OPEN`, `RELEASING`, `RELEASED`, `CANCELLED` | `RELEASING` is the transient state during sub-batch creation. |
| J | `Released_In_Sub_Batch` | text | `@` | — | Filled when row moves to `RELEASED`. Then row is deleted from this sheet. |

---

## 3. `Payroll_Types`

Canonical list of 23 payroll types + email templates per type.

- **Frozen rows:** 1
- **Frozen columns:** 1 (`Payroll_Type`)
- **Protected range:** entire sheet — Admin only.

### Columns

| Col | Header | Type | Format | Validation | Notes |
|---|---|---|---|---|---|
| A | `Payroll_Type` | text | — | unique | e.g. `Regular Payroll – Plantilla`. |
| B | `Code` | text | `@` | regex `^[A-Z]{2,5}$` | e.g. `PBP`. |
| C | `Quincena_Mode` | boolean | — | Dropdown: `YES`, `NO` | `YES` only for `PBP` and `COS`. |
| D | `Hold_Allowed` | boolean | — | Dropdown: `YES`, `NO` | `YES` only for `PBP` and `COS`. |
| E | `Notification_Subject` | text | — | — | Template with `{{batch_no}}`, `{{period}}`, `{{amount}}`. |
| F | `Notification_Body_HTML` | text | — | — | Full HTML template. Mustache placeholders. |
| G | `Active` | boolean | — | Dropdown: `YES`, `NO` | Allows soft-disabling without deleting. |

### Bootstrap seed

`setupComBenSchema()` populates all 23 rows with sensible defaults:
- `Code` per SPEC §0.4 table.
- `Quincena_Mode = YES` for `PBP`, `COS`; `NO` for all others.
- `Hold_Allowed = YES` for `PBP`, `COS`; `NO` for all others.
- `Notification_Subject` = `"[DAP] {{payroll_type}} for {{period}}"`.
- `Notification_Body_HTML` = a generic template; Admin edits per type.
- `Active = YES`.

---

## 4. `Authorizers`

Roster of authorizers who receive Phase 4 endorsement emails.

- **Frozen rows:** 1
- **Protected range:** entire sheet — Admin only.

### Columns

| Col | Header | Type | Validation |
|---|---|---|---|
| A | `Name` | text | required |
| B | `Email` | text | regex email |
| C | `Title` | text | optional |
| D | `Active` | boolean | Dropdown: `YES`, `NO` |
| E | `Notes` | text | optional |

---

## 5. `User_Database`

System users. Patterned on Treasury's `User_Database` but with the
`Maker` role added.

- **Frozen rows:** 1
- **Protected range:** entire sheet — Admin only.

### Columns

| Col | Header | Type | Format | Validation | Notes |
|---|---|---|---|---|---|
| A | `Email_Address` | text | — | regex email, unique | Primary key. |
| B | `Password_Hash` | text | `@` | 64-hex | SHA256(salt + password). |
| C | `Salt` | text | `@` | UUID-v4 | One per user. |
| D | `Role` | text | — | Dropdown: `Maker`, `Admin`, `Accounting` | (Authorizers are external to this system — they receive emails and act in WeAccess.) |
| E | `Status` | text | — | Dropdown: `Active`, `Disabled` | |
| F | `Display_Name` | text | — | — | |
| G | `Created_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | |
| H | `Last_Login_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | |

---

## 6. `Config`

Key-value config table, patterned on Treasury's `Config`. All settings
the system uses, no hardcoded values in code.

- **Frozen rows:** 1
- **Protected range:** entire sheet — Admin only.

### Columns

| Col | Header | Type | Notes |
|---|---|---|---|
| A | `Setting` | text | Unique key. |
| B | `Value` | text | Free-form; interpretation depends on key. |
| C | `Notes` | text | Optional human note. |

### Bootstrap seed (rows the setup script inserts as placeholders)

| Setting | Default value | Notes |
|---|---|---|
| `combenDriveRootFolderId` | (blank — Admin fills) | Root of ComBen Drive tree. |
| `archiveFolderId` | (blank) | `_archive/` folder for cold logs. |
| `treasuryBridgeUrl` | (blank) | URL of Treasury bridge web app (SPEC §15). |
| `treasuryBridgeTokenScriptProp` | `TREASURY_BRIDGE_TOKEN` | Name of the Script Properties entry holding the shared secret. **The token itself is stored in Script Properties, never in this sheet.** |
| `disbursingOfficerName` | `MARIA MONICA O. TALAN` | Annex H signatory. |
| `disbursingOfficerTitle` | (blank) | Annex H subtitle. |
| `disbursingOfficerSignatureFileId` | (blank) | Optional. |
| `annexHBankName` | `Landbank of the Philippines, Pasig Capitol Branch` | |
| `annexHIssuer` | `DAP` | |
| `accountingRecipients` | `padillaj@dap.edu.ph, preciadosr@dap.edu.ph, baguim@dap.edu.ph` | Comma-separated. |
| `adminEmail` | (blank) | For CM exception alerts (SPEC §7.4). |
| `emailHeaderHtml` | `<table style="background:#1C2790;…">` | DAP palette navy. |
| `emailFooterHtml` | `<div style="border-top:3px solid #CDAE2C;…">` | DAP palette gold. |
| `notificationTriggerRate` | `50` | Emails per minute (Phase 7 trigger). |
| `softWarnThresholdPhp` | `100000` | 6-figure soft-warn (PBP/COS only). |
| `signatureBatch_Letter_RegularPayroll` | `A=1st Quincena, B=2nd Quincena` | Display label. |

---

## 7. `Outbound_Email_Queue`

Transient queue for Phase 7 payee notifications. Time-driven trigger
drains at `notificationTriggerRate` per minute. Row deleted after
successful send.

- **Frozen rows:** 1

### Columns

| Col | Header | Type | Format | Notes |
|---|---|---|---|---|
| A | `Queue_ID` | text | `@` | UUID-v4. |
| B | `Batch_No` | text | `@` | |
| C | `Row_Index` | integer | `0` | Index into line-items JSON. |
| D | `Recipient_Email` | text | — | regex email |
| E | `Subject` | text | — | Rendered template. |
| F | `Body_HTML` | text | — | Rendered template. |
| G | `Status` | text | — | Dropdown: `QUEUED`, `SENDING`, `SENT`, `FAILED`. |
| H | `Attempts` | integer | `0` | Incremented on each try. |
| I | `Last_Error` | text | — | On `FAILED`. |
| J | `Enqueued_At` | datetime | `yyyy-mm-dd HH:mm:ss` | |
| K | `Sent_At` | datetime | `yyyy-mm-dd HH:mm:ss` | |

Retry policy: max 3 attempts; transition to `FAILED` after; Admin sees
in health panel.

---

## 8. `HRIS_Pending_Changes`

Queue of pending enrollment requests routed to Admin for approval
(SPEC §15). ADD requests auto-approve but still create a row here for
audit visibility.

- **Frozen rows:** 1

### Columns

| Col | Header | Type | Format | Validation | Notes |
|---|---|---|---|---|---|
| A | `Request_ID` | text | `@` | UUID-v4 | Primary key. |
| B | `Requested_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | |
| C | `Requested_By` | text | — | regex email | Maker. |
| D | `Action` | text | — | Dropdown: `ADD`, `MODIFY`, `REMOVE` | |
| E | `HRIS_ID` | text | `@` | regex `^\d{6}$` | 6-digit padded. For `ADD`, the proposed new ID. |
| F | `Before_JSON` | text | — | — | Snapshot of master row before change. Blank for `ADD`. |
| G | `After_JSON` | text | — | — | Proposed state. Blank for `REMOVE` (soft-delete). |
| H | `Status` | text | — | Dropdown: `PENDING`, `APPROVED`, `REJECTED`, `AUTO_APPROVED` | `ADD` requests immediately resolve to `AUTO_APPROVED`. |
| I | `Decision_At` | datetime | `yyyy-mm-dd HH:mm:ss` | — | |
| J | `Decision_By` | text | — | regex email | Admin. |
| K | `Decision_Note` | text | — | — | Required for `REJECTED`. |
| L | `Treasury_Bridge_Response` | text | — | — | Raw response payload from Treasury bridge call (audit). |

---

## 9. `Audit_Log_<YYYY>`

Append-only event log. Year-partitioned. On year rollover, the
previous year's sheet is exported to `<archiveFolderId>/Audit_Log_<YYYY>.jsonl`
and cleared.

- **Frozen rows:** 1
- **Protected range:** entire sheet — write via the Audit service only.

### Columns

| Col | Header | Type | Format | Notes |
|---|---|---|---|---|
| A | `Event_ID` | text | `@` | UUID-v4. |
| B | `Timestamp` | datetime | `yyyy-mm-dd HH:mm:ss` | UTC+8. |
| C | `Actor_Email` | text | — | The user or `SYSTEM` for trigger-driven events. |
| D | `Role` | text | — | `Maker`, `Admin`, `SYSTEM`. |
| E | `Action` | text | — | Canonical action name (see §B below). |
| F | `Target_Type` | text | — | `BATCH`, `LINE_ITEM`, `PAYEE`, `EMAIL`, etc. |
| G | `Target_Id` | text | — | e.g. `Batch_No`, `HRIS_ID`, `Queue_ID`. |
| H | `Before_JSON` | text | — | State before change (for mutations). |
| I | `After_JSON` | text | — | State after change. |
| J | `Note` | text | — | Free-form (e.g. justification on exception ack). |
| K | `Source_IP` | text | — | If available from web app context. |

---

## 10. `_Setup_Log`

Audit of every `setupComBenSchema()` and `verifyComBenSchema()` run.

- **Frozen rows:** 1

### Columns

| Col | Header | Type | Notes |
|---|---|---|---|
| A | `Run_At` | datetime | |
| B | `Function` | text | `setupComBenSchema` or `verifyComBenSchema`. |
| C | `Run_By` | text | Admin email. |
| D | `Outcome` | text | `OK`, `OK_WITH_CHANGES`, `FAILED`. |
| E | `Changes_JSON` | text | List of additive changes (sheets created, columns added, formats applied). |
| F | `Missing_JSON` | text | (verify only) List of missing items. |
| G | `Duration_Ms` | integer | |
| H | `Notes` | text | |

---

## §A. `Payee_Database` (Treasury-owned — for reference only)

Documented here so ComBen developers know the shape of what the bridge
returns. Do **not** create this sheet in the ComBen spreadsheet.

| Col | Header | Type | Format | Notes |
|---|---|---|---|---|
| A | `Payee Name` | text | — | `SURNAME, GIVEN_NAMES M.I.` |
| B | `Landbank Account` | text | `@` (should be) | 10 digits, leading zeros possibly stripped — normalize on read. |
| C | `Email Address` | text | — | May be `inactive employee` or a real email. |
| D | `HRIS Number` | text | `@` (should be) | 6 digits, leading zeros possibly stripped. May be `N/A` for non-DAP entries (those are rejected by ComBen). |

Bridge response shape (what `GET ?op=lookup&hris_id=209803` returns):

```json
{
  "found": true,
  "hris_id": "209803",
  "payee_name": "ABALOS, MICHAEL P.",
  "landbank_account": "1507060419",
  "email": "inactive employee",
  "is_active_email": false
}
```

`is_active_email` is `false` when the `Email Address` cell is the
sentinel `inactive employee`. ComBen treats such rows as eligible for
FINDES (the bank doesn't care about email) but skips them in Phase 7
notifications and surfaces them in the review UI.

---

## §B. Canonical audit action names

Used in `Audit_Log_<YYYY>.Action`. Implementation must use these exact
strings.

| Action | When emitted |
|---|---|
| `LOGIN_SUCCESS` | User authenticates. |
| `LOGIN_FAILURE` | Bad password / disabled user. |
| `BATCH_CREATED` | Phase 1 commit. |
| `BATCH_REVIEW_OPENED` | Phase 2 entry. |
| `ROW_HELD` | Maker holds a row in Phase 2. |
| `ROW_UNHELD` | Maker unholds before submit. |
| `BATCH_SUBMITTED` | Phase 2 → Phase 3. |
| `FINDES_GENERATED` | Phase 3 success. |
| `AUTHORIZER_EMAIL_SENT` | Phase 4 send. |
| `CM_UPLOADED` | Phase 6 file accepted. |
| `CM_EXCEPTION_ACKED` | Maker acks exception with justification. |
| `CM_CONFIRMED` | Phase 6 gate cleared. |
| `NOTIFICATION_QUEUED` | One row per payee enqueued in Phase 7. |
| `NOTIFICATION_SENT` | Trigger drains a queue row. |
| `NOTIFICATION_FAILED` | Final attempt failed. |
| `ANNEX_H_GENERATED` | Phase 8 success. |
| `ACCOUNTING_HANDOFF_SENT` | Phase 9 send. |
| `BATCH_CLOSED` | Accounting acknowledges receipt. |
| `SUB_BATCH_CREATED` | Hold release. |
| `WEACCESS_UPLOADED` | Maker confirms FINDES uploaded to WeAccess (Phase 5). |
| `BATCH_CANCELLED` | Admin cancels a `Draft` or `Pending Approval` batch. |
| `BATCH_NOTIFICATIONS_DRAINED` | All queued notifications for a batch have been sent (drains to status `Notifications Sent`). |
| `ENROLLMENT_ADD_AUTO_APPROVED` | Maker ADD writes via bridge. |
| `ENROLLMENT_MODIFY_REQUESTED` | Maker submits MODIFY for Admin approval. |
| `ENROLLMENT_REMOVE_REQUESTED` | Maker submits REMOVE for Admin approval. |
| `ENROLLMENT_APPROVED` | Admin approves a pending change. |
| `ENROLLMENT_REJECTED` | Admin rejects (note required). |
| `INTEGRITY_VIOLATION` | SHA256 mismatch on line-items JSON or FINDES read. |
| `HEAL_LEADING_ZERO` | Admin heals a leading-zero anomaly via §11.4. |
| `SCHEMA_BOOTSTRAP` | `setupComBenSchema()` run. |
| `SCHEMA_VERIFY` | `verifyComBenSchema()` run. |

---

## §C. Bootstrap script behavior summary

`setupComBenSchema(spreadsheetId)`:

1. Open spreadsheet.
2. For each sheet in this document:
   - If it does not exist → create with header row, frozen rows,
     number formats, validations, conditional formats, protected
     range.
   - If it exists → leave existing data untouched; only **add**
     missing columns (header + format + validation) at the next
     unused column index. Never reorder, never remove.
3. Apply `@` text format to every column flagged `@` in this document
   (idempotent).
4. Seed `Payroll_Types` if empty (23 rows).
5. Seed `Config` placeholders if the key is missing; never overwrite
   an existing value.
6. Create Drive folders: `<combenDriveRootFolderId>/<current year>/`
   and the 12 month subfolders.
7. Write a `_Setup_Log` row with `Outcome = OK_WITH_CHANGES` listing
   everything created.
8. Return a structured report.

`verifyComBenSchema(spreadsheetId)`:

Read-only. Walks the same structure and reports missing sheets,
missing columns, wrong formats, missing validations. Returns
`Outcome = OK` if all present, `Outcome = FAILED` with a `Missing_JSON`
payload otherwise.
