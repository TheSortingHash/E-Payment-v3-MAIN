# ComBen — Web app endpoint map

> **Status:** LOCKED. Implements SPEC §1 (workflow), §13 (M&E surface),
> §14 (security), §15 (enrollment), §16 (Annex H), and the file
> browser (§12).

This file enumerates every server-side function the ComBen Apps Script
web app exposes. Together with `SPEC.md` and `SCHEMA.md` it is the
build-phase contract.

---

## §A. Conventions

### A.1 Transport

Two transport patterns are used:

| Pattern | When | Example |
|---|---|---|
| `google.script.run.<fn>(args)` | Default for all interactive actions | `google.script.run.batch_submit({batch_no:'04APBP26'})` |
| `doGet(e)` HTTP route | File downloads, PDF preview, public OAuth callbacks if any | `?route=download&kind=findes&batch=04APBP26` |

Default is `google.script.run`. HTTP routes are listed explicitly in
§F.

### A.2 Response envelope

Every server function returns the same shape:

```json
{
  "ok": true,
  "data": { ... },
  "error": null,
  "audit_event_id": "<uuid>"
}
```

On failure:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "FORBIDDEN" | "VALIDATION" | "STATE" | "INTEGRITY" | "BRIDGE" | "INTERNAL",
    "message": "Human-readable message safe to display.",
    "details": { ... }
  },
  "audit_event_id": "<uuid|null>"
}
```

- `FORBIDDEN`  — role/state check failed.
- `VALIDATION` — input shape or content invalid.
- `STATE`      — state-machine precondition not met (e.g. cannot
  generate FINDES from `Closed` batch).
- `INTEGRITY`  — SHA256 mismatch on line-items JSON or FINDES.
- `BRIDGE`     — Treasury bridge call failed.
- `INTERNAL`   — unexpected exception.

### A.3 Authentication and role enforcement

- Every endpoint begins with `requireRole(['Maker','Admin', …])`
  before any work.
- Role is looked up in `User_Database` by the authenticated session's
  email.
- A `Maker` may also exercise `Admin`-allowed reads (read endpoints
  are permissive); writes are role-strict.
- All mutating endpoints take `LockService` on the relevant
  `Batch_No` (per SPEC §14.5).

### A.4 Audit

Every successful mutation appends one row to `Audit_Log_<YYYY>` using
a canonical action name from `SCHEMA.md` §B. The `audit_event_id` in
the response is the `Event_ID` of that row.

### A.5 Idempotency

Endpoints marked **idempotent** can be safely retried with the same
input. The caller may supply `client_request_id` (UUID) in args; the
server stores the last response keyed on
`(actor_email, fn_name, client_request_id)` for 24 hours and replays
on collision.

---

## §B. Maker endpoints

### B.1 `batch_create`

Create a new batch from the upload form (Phase 1).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | none |
| State postcondition | new row in `Master_Payroll_Batches_<YYYY>` with `Status = Draft` |
| Audit action | `BATCH_CREATED` |
| Idempotent | yes (via `client_request_id`) |

**Input:**

```json
{
  "client_request_id": "<uuid>",
  "payroll_type": "Regular Payroll – Plantilla",
  "period_covered": "April 1-15, 2026",
  "batch_letter": "A",
  "year_yy": "26",
  "month_mm": "04",
  "payroll_file_blob_id": "<temp Drive ID of uploaded xlsx>",
  "supporting_doc_blob_ids": ["<id1>", "<id2>"]
}
```

**Behavior:**
1. Validate `payroll_type` against `Payroll_Types`.
2. Validate `batch_letter` against §0.5 (must be `A`/`B` for
   `Quincena_Mode=YES` types; sequential next for others).
3. Compute `Batch_No = mm + L + CODE + yy`.
4. Parse the uploaded xlsx into the line-items array. For each row:
   - Pad `HRIS_ID` to 6.
   - Look up canonical record via Treasury bridge.
   - Pad `Landbank Account` to 10.
   - Mark `name_match` (file vs master).
5. Move payroll file to `<batch>/PAYROLL_UPLOAD_<BatchNo>.xlsx`
   (frozen evidence).
6. Move supporting docs to `<batch>/supporting_docs/`.
7. Write `LINE_ITEMS_<BatchNo>.json` and capture SHA256.
8. Create batch head row with `Status = Draft`.

**Output `data`:**

```json
{
  "batch_no": "04APBP26",
  "line_items_count": 372,
  "active_count": 372,
  "errors_count": 0,
  "warnings_count": 3
}
```

**Errors:** `VALIDATION` if file shape wrong; `BRIDGE` if bridge
unreachable.

---

### B.2 `batch_get_review`

Fetch the review-table dataset for a batch (Phase 2 entry; also used
by the M&E surface — SPEC §13).

| | |
|---|---|
| Role | `Maker`, `Admin`, `Accounting` (read-only post-`Forwarded to Accounting`) |
| State precondition | batch exists |
| Audit action | `BATCH_REVIEW_OPENED` (first open per session only) |

**Input:** `{ "batch_no": "04APBP26" }`

**Behavior:**
1. Load batch head row.
2. Load `LINE_ITEMS_<BatchNo>.json`, verify SHA256. Mismatch →
   `INTEGRITY` error and `INTEGRITY_VIOLATION` audit.
3. Return rendered rows for the table. Columns shown vary by batch
   stage (see SPEC §13).

**Output `data`:**

```json
{
  "batch": { /* head row, see SCHEMA §1 */ },
  "rows": [
    {
      "row_index": 0,
      "hris_id": "205816",
      "hris_name_file": "ABAYA, NATASHA MICHELLE V.",
      "hris_name_master": "ABAYA, NATASHA MICHELLE V.",
      "name_match": true,
      "amount_php": 12309.95,
      "account_no": "0677125438",
      "email": "abayan@dap.edu.ph",
      "status": "ACTIVE",
      "bank_status": null,
      "notification_status": null,
      "hold_reason": null
    }
  ],
  "summary": {
    "total": 372,
    "active": 372,
    "hold": 0,
    "errors": 0,
    "declared_total": 12345678.90,
    "computed_total": 12345678.90
  },
  "ui_capabilities": {
    "hold_allowed": true,
    "submit_allowed": true,
    "cm_upload_allowed": false
  }
}
```

---

### B.3 `row_hold`

Mark a single row HOLD (Phase 2). PBP/COS only.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Draft` AND `Payroll_Types.Hold_Allowed = YES` for this type |
| Audit action | `ROW_HELD` |

**Input:**
```json
{ "batch_no": "04APBP26", "row_index": 17, "hold_reason": "No DTR submitted as of cut-off" }
```

**Behavior:**
1. Lock batch.
2. Mutate row in line-items JSON: `status = HOLD`, `hold_reason`.
3. Recompute SHA256, update batch head row.
4. Insert row in `Held_Records_Open`.
5. Update batch counts (`Active_Count`, `Hold_Count`, `Total_Held`).

**Errors:** `STATE` if not `Draft` or hold not allowed.

---

### B.4 `row_unhold`

Reverse a hold before Submit.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Draft`, row currently `HOLD` |
| Audit action | `ROW_UNHELD` |

**Input:** `{ "batch_no": "04APBP26", "row_index": 17 }`

---

### B.5 `rows_hold_bulk`

Mark many rows HOLD in one transaction.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | `ROW_HELD` (one per row) |

**Input:**
```json
{
  "batch_no": "04APBP26",
  "rows": [{"row_index": 17, "hold_reason": "..."}, ...]
}
```

---

### B.6 `batch_submit`

Submit the batch for approval (Phase 2 → Phase 3).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Draft` AND errors=0 AND `declared_total == computed_total` |
| State postcondition | `Status = Pending Approval`; FINDES generated; authorizer email sent |
| Audit action | `BATCH_SUBMITTED`, `FINDES_GENERATED`, `AUTHORIZER_EMAIL_SENT` |
| Idempotent | yes |

**Input:** `{ "batch_no": "04APBP26", "client_request_id": "<uuid>" }`

**Behavior:**
1. Validate gate (errors=0, totals match).
2. Call `findes_generate` internally (§B.7 — same logic).
3. Compose and send authorizer summary email (SPEC §7.1).
4. Transition `Status = Pending Approval`.

---

### B.7 `findes_regenerate`

Regenerate the FINDES file. Used when the batch returns from
`Pending Approval` to `Draft` for corrections, or when a sub-batch is
created.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status ∈ {Draft, Pending Approval}` |
| Audit action | `FINDES_GENERATED` |
| Idempotent | yes (overwrites with .bak per SPEC §10.9) |

**Input:** `{ "batch_no": "04APBP26" }`

**Behavior:** Full FINDES per SPEC §10 — sanity stop, padding,
name cleaning, idempotent save.

---

### B.8 `weaccess_mark_uploaded`

Mark that the FINDES has been uploaded to WeAccess (Phase 5 — external).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Pending Approval` |
| State postcondition | `Status = Bank Processing` |
| Audit action | `BATCH_SUBMITTED` (variant `WEACCESS_UPLOADED` — add to canonical list) |

**Input:** `{ "batch_no": "04APBP26", "weaccess_note": "Uploaded 9:42 AM" }`

> **Note for SCHEMA §B canonical actions:** add `WEACCESS_UPLOADED`.

---

### B.9 `cm_upload`

Upload the Landbank Credit Memo xlsx (Phase 6 entry).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Bank Processing` |
| Audit action | `CM_UPLOADED` |

**Input:**
```json
{ "batch_no": "04APBP26", "cm_blob_id": "<temp Drive ID>" }
```

**Behavior:**
1. Parse CM xlsx (SPEC §4.1).
2. Build match table against batch line items.
3. Save CM file to `<batch>/CM_<BatchNo>_<TRN>.xlsx`.
4. Return match table; do **not** yet transition status.

**Output `data`:** match table (see `cm_match_table` shape below).

---

### B.10 `cm_get_match_table`

Re-fetch the CM match table without re-uploading.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Bank Processing` AND CM file exists |

**Output `data`:**

```json
{
  "trn": "246-067-260508-60636",
  "bank_tx_datetime": "2026-05-08 11:46:06",
  "rows": [
    {
      "row_index": 0,
      "hris_id": "205816",
      "batch_account": "0677125438",
      "batch_amount": 12309.95,
      "cm_account": "0677125438",
      "cm_amount": 12309.95,
      "cm_tx_datetime": "2026-05-08 11:46:06",
      "match": "MATCHED" | "NOT_IN_CM" | "EXTRA_IN_CM" | "AMOUNT_MISMATCH",
      "ack": null | { "by": "...", "at": "...", "note": "..." }
    }
  ],
  "summary": { "matched": 369, "not_in_cm": 1, "extra_in_cm": 2, "amount_mismatches": 0 }
}
```

---

### B.11 `cm_ack_exception`

Acknowledge a single CM exception with a justification note.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | `CM_EXCEPTION_ACKED` |

**Input:**
```json
{ "batch_no": "04APBP26", "row_index": 17, "match_kind": "NOT_IN_CM", "note": "Bank rejected — wrong branch. Will reissue." }
```

---

### B.12 `cm_confirm`

Confirm Phase 6 — gate to Phase 7.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Bank Processing` AND (zero exceptions OR all exceptions acked) |
| State postcondition | `Status = Bank-Confirmed`; line-items rows updated with bank_status; notification queue populated |
| Audit action | `CM_CONFIRMED`, `NOTIFICATION_QUEUED` (one per CONFIRMED row) |

**Input:** `{ "batch_no": "04APBP26", "client_request_id": "<uuid>" }`

**Behavior:**
1. Validate all exceptions are acked.
2. Mutate line-items JSON: matched rows → `bank_status=CONFIRMED`,
   `bank_confirmed_at`, `cm_trn`. Unmatched → `bank_status=NOT_PAID`.
3. Recompute SHA256, update batch head row.
4. Populate `Outbound_Email_Queue` with one row per CONFIRMED payee
   that has a real email (i.e., not `inactive employee`).
5. Status → `Bank-Confirmed`.

---

### B.13 `annex_h_generate`

Generate the Annex H PDF (Phase 8).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Notifications Sent` (the trigger drained the queue) |
| State postcondition | `Status = Annex H Generated` |
| Audit action | `ANNEX_H_GENERATED` |

**Input:** `{ "batch_no": "04APBP26" }`

**Behavior:**
1. Reserve next `Annex H Report No.` for the month via LockService
   (SCHEMA §1 col V).
2. Render PDF per SPEC §16 from CONFIRMED rows only.
3. Save to `<batch>/Annex_H_<BatchNo>.pdf`.
4. Write `Annex_H_File_ID`, `Annex_H_Report_No`.

---

### B.14 `accounting_handoff`

Send Phase 9 handoff email.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | `Status = Annex H Generated` |
| State postcondition | `Status = Forwarded to Accounting`; `Handoff_Email_Sent_At` set |
| Audit action | `ACCOUNTING_HANDOFF_SENT` |
| Idempotent | yes |

**Input:** `{ "batch_no": "04APBP26", "client_request_id": "<uuid>" }`

---

### B.15 `sub_batch_create`

Create a hold-release sub-batch.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| State precondition | parent batch `Status ∈ {Closed, Partially Released - Hold Pending}` AND has at least one `HOLD` row in `Held_Records_Open` |
| State postcondition | new sub-batch row with `Parent_Batch_No`, `Status = Draft`; selected hold rows move to sub-batch's JSON |
| Audit action | `SUB_BATCH_CREATED`, `ROW_UNHELD` (one per row), `BATCH_CREATED` |

**Input:**
```json
{
  "parent_batch_no": "04APBP26",
  "row_indexes_to_release": [17, 42],
  "client_request_id": "<uuid>"
}
```

**Behavior:**
1. Compute next sub-batch number: scan existing sub-batches under
   parent; next `_NN` = max + 1, starting at `_02`.
2. Create new batch head row with that number.
3. Move selected rows from parent JSON (`HOLD`) to new sub-batch JSON
   (`ACTIVE`). Update both SHA256s. Delete corresponding rows from
   `Held_Records_Open`.

---

## §C. Enrollment endpoints (Maker + Admin)

### C.1 `enrollment_lookup`

Look up a payee via Treasury bridge (used by the enrollment form to
check existence before submitting).

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | none (read-only) |

**Input:** `{ "hris_id": "205816" }` (auto-padded server-side)

**Output `data`:** bridge response (SCHEMA §A).

---

### C.2 `enrollment_add`

ADD a payee. Auto-approved per SPEC §15.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | `ENROLLMENT_ADD_AUTO_APPROVED` |
| Idempotent | yes |

**Input:**
```json
{
  "client_request_id": "<uuid>",
  "hris_id": "213700",
  "payee_name": "DELA CRUZ, JUAN P.",
  "landbank_account": "0677500001",
  "email": "delacrucj@dap.edu.ph"
}
```

**Behavior:**
1. Pad HRIS_ID to 6, account to 10.
2. Call Treasury bridge `POST ?op=add`.
3. On success: write `HRIS_Pending_Changes` row with
   `Status=AUTO_APPROVED`.

---

### C.3 `enrollment_request_modify`

Request a MODIFY (name, account, or email). Awaits Admin approval.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | `ENROLLMENT_MODIFY_REQUESTED` |

**Input:**
```json
{
  "hris_id": "213700",
  "before": { "payee_name": "...", "landbank_account": "...", "email": "..." },
  "after":  { "payee_name": "...", "landbank_account": "...", "email": "..." },
  "reason": "Account number changed per signed Annex A dated 2026-05-01."
}
```

**Behavior:** snapshot current state via bridge `lookup`, write
`HRIS_Pending_Changes` row with `Status=PENDING`.

---

### C.4 `enrollment_request_remove`

Request a REMOVE (soft-delete). Awaits Admin approval.

| | |
|---|---|
| Role | `Maker`, `Admin` |
| Audit action | `ENROLLMENT_REMOVE_REQUESTED` |

**Input:** `{ "hris_id": "213700", "reason": "Resigned 2026-04-30." }`

---

### C.5 `enrollment_decide` (Admin)

Approve or reject a pending change.

| | |
|---|---|
| Role | `Admin` |
| Audit action | `ENROLLMENT_APPROVED` or `ENROLLMENT_REJECTED` |

**Input:**
```json
{ "request_id": "<uuid>", "decision": "APPROVE" | "REJECT", "note": "..." }
```

**Behavior:**
- `APPROVE`: call Treasury bridge `POST ?op=modify` (or `remove`).
  Update `HRIS_Pending_Changes.Status = APPROVED` and store
  `Treasury_Bridge_Response`.
- `REJECT`: update status only; do not call bridge. `note` required.

---

### C.6 `enrollment_list_pending` (Admin)

List pending requests for the Admin queue UI.

| | |
|---|---|
| Role | `Admin` |
| Audit action | none |

**Output `data`:** array of `HRIS_Pending_Changes` rows with
`Status=PENDING`, sorted by `Requested_At`.

---

## §D. Admin-only endpoints

### D.1 `schema_setup`

Run `setupComBenSchema()` (SCHEMA §C).

| | |
|---|---|
| Role | `Admin` |
| Audit action | `SCHEMA_BOOTSTRAP` |

**Input:** `{}` (uses current spreadsheet from context)

**Output `data`:** report from `_Setup_Log`.

---

### D.2 `schema_verify`

Run `verifyComBenSchema()` (SCHEMA §C).

| | |
|---|---|
| Role | `Admin` |
| Audit action | `SCHEMA_VERIFY` |

---

### D.3 `health_summary`

Return Admin health-panel data.

| | |
|---|---|
| Role | `Admin` |
| Audit action | none |

**Output `data`:**

```json
{
  "leading_zero_anomalies": {
    "landbank_account": 41,
    "hris_id": 0
  },
  "failed_notifications_last_7_days": 3,
  "bridge_failures_last_7_days": 0,
  "integrity_violations_last_7_days": 0,
  "queue_depth": 12,
  "open_holds": 5,
  "open_enrollment_requests": 2
}
```

---

### D.4 `health_heal_leading_zero`

Heal a single leading-zero anomaly via bridge.

| | |
|---|---|
| Role | `Admin` |
| Audit action | `HEAL_LEADING_ZERO` |

**Input:** `{ "hris_id": "205816", "field": "landbank_account" | "hris_number" }`

---

### D.5 `batch_cancel`

Cancel a batch in `Draft` or `Pending Approval`.

| | |
|---|---|
| Role | `Admin` |
| State precondition | `Status ∈ {Draft, Pending Approval}` |
| State postcondition | `Status = Cancelled` |
| Audit action | `BATCH_CANCELLED` |

**Input:** `{ "batch_no": "04APBP26", "reason": "..." }`

> **Note for SCHEMA §B canonical actions:** add `BATCH_CANCELLED`.

---

### D.6 `audit_query`

Query the audit log (Admin review).

| | |
|---|---|
| Role | `Admin` |

**Input:**
```json
{ "year": 2026, "from": "...", "to": "...", "actor_email": "...", "action": "...", "target_id": "..." }
```

**Output `data`:** paginated rows.

---

## §E. Auth endpoints

### E.1 `auth_login`

Login. Adapted from Treasury `Code.gs:1079`.

| | |
|---|---|
| Role | public (pre-auth) |
| Audit action | `LOGIN_SUCCESS` or `LOGIN_FAILURE` |

**Input:** `{ "email": "...", "password": "..." }`

**Behavior:**
1. Lookup user in `User_Database`.
2. Compute `sha256(salt + password)` and compare against
   `Password_Hash`.
3. If `Status != Active` → `FORBIDDEN`.
4. On success: set session, update `Last_Login_At`.

**Output `data`:** `{ "role": "Maker" | "Admin" | "Accounting", "display_name": "..." }`

---

### E.2 `auth_logout`

Clear session.

| | |
|---|---|
| Role | any authenticated |

---

### E.3 `auth_whoami`

Current session identity (for client hydration).

| | |
|---|---|
| Role | any authenticated |

**Output `data`:** `{ "email": "...", "role": "...", "display_name": "..." }`

---

## §F. HTTP routes (`doGet(e)`)

Three uses only — everything else goes through `google.script.run`.

### F.1 `?route=download&kind=<k>&batch=<b>`

Stream a batch artifact for download.

| `kind` | Returns |
|---|---|
| `payroll_upload` | `<batch>/PAYROLL_UPLOAD_<BatchNo>.xlsx` |
| `findes` | `<batch>/FINDES_<BatchNo>.csv` |
| `cm` | `<batch>/CM_<BatchNo>_<TRN>.xlsx` |
| `annex_h` | `<batch>/Annex_H_<BatchNo>.pdf` |
| `held_records_report` | `<batch>/Held_Records_Report_<BatchNo>.pdf` |

| | |
|---|---|
| Role | any authenticated |
| Behavior | Verifies SHA256 (where applicable), then redirects to the Drive file URL OR streams via `ContentService` with proper MIME. |
| Errors | `404` if missing; `INTEGRITY` if hash mismatch. |

### F.2 `?route=preview&file_id=<id>`

PDF preview iframe target for the file browser (SPEC §12). Returns
the Drive viewer URL via `HtmlService` wrapping
`https://drive.google.com/file/d/<id>/preview`. Role-gated; verifies
that `file_id` resolves under `combenDriveRootFolderId`.

### F.3 `?route=app` (default)

Returns the SPA shell (`HtmlService.createHtmlOutputFromFile('index')`)
which then drives everything via `google.script.run`.

---

## §G. File browser endpoints

### G.1 `files_list`

List children of a folder under the ComBen Drive root.

| | |
|---|---|
| Role | any authenticated |
| Audit action | none |

**Input:**
```json
{
  "folder_id": "<id>" | null,
  "filters": { "type": null | "annex_h" | "findes" | "supporting_docs", "name_contains": "" }
}
```

`folder_id = null` returns the root listing (year folders).

**Output `data`:** array of `{ id, name, mime, size, modified_at, kind }`
where `kind ∈ folder | file`.

### G.2 `files_breadcrumb`

Compute breadcrumb path for a folder.

**Input:** `{ "folder_id": "<id>" }`
**Output `data`:** array of `{ id, name }` from root to current.

---

## §H. Background triggers (not endpoints — documented for completeness)

These run on time-driven triggers, not user requests.

### H.1 `trigger_drain_notification_queue`

Runs every minute. Pulls up to `notificationTriggerRate` (default 50)
rows from `Outbound_Email_Queue` with `Status=QUEUED`, sends each via
`GmailApp`. On success: `Status=SENT`, `Sent_At`, row deleted.
On failure: increment `Attempts`; after 3, `Status=FAILED`.

When a batch's queue is fully drained:
- Status → `Notifications Sent`.
- Audit: one `BATCH_NOTIFICATIONS_DRAINED` event.

> **Note for SCHEMA §B canonical actions:** add
> `BATCH_NOTIFICATIONS_DRAINED`.

### H.2 `trigger_year_rollover`

Runs January 1 at 00:05. Creates
`Master_Payroll_Batches_<new year>` and `Audit_Log_<new year>`,
protects the previous-year sheets, exports
`Audit_Log_<prev year>` to JSONL in `_archive/`.

### H.3 `trigger_health_alert`

Runs daily at 08:00. If any of the following exceeds threshold,
emails Admin a one-page health digest:
- Failed notifications > 5 in last 24h.
- Bridge failures > 0 in last 24h.
- Integrity violations > 0 ever.
- Queue depth > 500.

---

## §I. Concurrency map

Endpoints that take `LockService.getScriptLock()` keyed on
`Batch_No`:

```
batch_create, row_hold, row_unhold, rows_hold_bulk, batch_submit,
findes_regenerate, cm_upload, cm_ack_exception, cm_confirm,
annex_h_generate, accounting_handoff, sub_batch_create, batch_cancel
```

Endpoints that take `LockService` keyed on `Payee_Database` (via the
bridge — bridge enforces server-side):

```
enrollment_add, enrollment_decide (on APPROVE), health_heal_leading_zero
```

Endpoints that take `LockService` keyed on the
`Annex_H_Report_No` counter for the month:

```
annex_h_generate
```

---

## §J. Treasury bridge (called by ComBen — not exposed)

Per SPEC §15, ComBen calls a Treasury-owned web app via
`UrlFetchApp`. Endpoints (re-stated here for the build-phase
contract):

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `?op=lookup&hris_id=<id>` | Header `Authorization: Bearer <token>` | — |
| POST | `?op=add` | Header `Authorization: Bearer <token>` | `{ requester, hris_id, payee_name, landbank_account, email }` |
| POST | `?op=modify` | Header `Authorization: Bearer <token>` | `{ requester, hris_id, before, after }` |
| POST | `?op=remove` | Header `Authorization: Bearer <token>` | `{ requester, hris_id, reason }` |

Token lives in Script Properties under
`Config.treasuryBridgeTokenScriptProp` (default key name
`TREASURY_BRIDGE_TOKEN`). Bridge response shape: see SCHEMA §A.

---

## §K. Additions to SCHEMA §B canonical action names

The endpoint specification above references three actions not yet
listed in `SCHEMA.md` §B. Add to SCHEMA in the next commit:

- `WEACCESS_UPLOADED` — emitted by `weaccess_mark_uploaded` (§B.8).
- `BATCH_CANCELLED` — emitted by `batch_cancel` (§D.5).
- `BATCH_NOTIFICATIONS_DRAINED` — emitted by the queue trigger when a
  batch's queue is fully drained (§H.1).
