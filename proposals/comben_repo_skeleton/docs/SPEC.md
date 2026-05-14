# E-Payment-ComBen-v1 — Specification

> **Status:** In progress. Sections marked **LOCKED** are confirmed; sections
> marked **[TO BE DRAFTED]** still need walkthrough. Do not implement against
> any non-LOCKED section.

---

## 0. Scope and non-goals — **LOCKED**

### 0.1 In scope

- Disbursement of compensation & benefits payroll items to government
  employees via Landbank FINDES upload.
- One payroll type per batch (per the canonical table in §0.4).
- End-to-end workflow: 9 phases, §1.
- Roles: Maker (ComBen), Admin (system administrator — user), Authorizers
  (Treasury), Accounting.
- Google Sheets backend + Apps Script web app + Google Drive for
  artifacts.
- **Payee enrollment module** inside ComBen web app:
  - ADD payee: Maker writes directly to Treasury-owned `Payee_Database`
    (auto-allowed; logged).
  - REMOVE / MODIFY (name, Landbank account): requires Admin approval.

### 0.2 Non-goals

- DV-style disbursements — handled by Treasury E-Payment v3.
- PCF replenishment / Revolving Fund establishment — DV-only.
- Tax / GSIS / PhilHealth / Pag-IBIG deduction computation. **ComBen
  receives net-pay amounts** already computed upstream by HR/Payroll.
- General-ledger posting — ComBen produces the handoff package;
  Accounting team posts in their own system.

### 0.3 Source of truth: Treasury's existing `Payee_Database` — **LOCKED**

The "master HRIS database" we previously sketched **does not need to be
built**. Treasury's existing `Payee_Database` already has the four
fields we need (1,427 rows currently):

| Column | Purpose |
|---|---|
| Payee Name | Display + Landbank name field |
| Landbank Account | Account number — **10 digits**, leading zeros may be stripped (see §11) |
| Email Address | Payee notification address |
| HRIS Number | Primary key used by ComBen — **6 digits**, leading zeros may be stripped (see §11) |

- **Lookup key for ComBen: HRIS Number** (6-digit string, leading zeros
  preserved via padding — see §11).
- ComBen reads `Payee_Database` via a read-only bridge.
- ComBen's enrollment module routes ADD writes directly and REMOVE /
  MODIFY through an Admin-approval queue (§15).
- This is a real simplification of the original "build a separate
  HRIS_Master" plan.

**Edge case — non-DAP payees.** Treasury's `Enrollment_Requests` has
`HRIS_Number = "N/A"` rows (e.g., external consultants). These should
not appear in ComBen batches — ComBen is for DAP employee payroll
only. Upload validation in Phase 2 hard-blocks any `HRIS_ID` that does
not resolve to a numeric (post-padding) value in `Payee_Database`.

### 0.4 Canonical payroll types and batch codes — **LOCKED**

Batch number format: `[mm][L][CODE][yy]`

- `[mm]` — 2-digit month (`01`–`12`)
- `[L]`  — batch letter (§0.5)
- `[CODE]` — payroll-type code from the table below
- `[yy]` — 2-digit year

| # | Payroll Type | Code |
|---|---|---|
| 1 | RATA | RT |
| 2 | Communication Expenses | CE |
| 3 | Regular Payroll – Plantilla | PBP |
| 4 | Regular Payroll – COS | COS |
| 5 | Monetization | MON |
| 6 | Loyalty Pay | LOYA |
| 7 | Step Increment Differential | SI |
| 8 | Promotion Differential | PRO |
| 9 | RATA OIC | RTOIC |
| 10 | Service Charge | SC |
| 11 | Mid Year Bonus | MYB |
| 12 | Year End Bonus and Cash Gift | YEBCG |
| 13 | Productivity Enhancement Incentive | PEI |
| 14 | Service Recognition Incentive | SRI |
| 15 | Performance Based Bonus | PBB |
| 16 | Loan Refund | REF |
| 17 | Landbank Loan Refund | LBP |
| 18 | Overtime Payroll – Plantilla | PBPOT |
| 19 | Overtime Payroll – COS | COSOT |
| 20 | Differential – COS | COSDIF |
| 21 | Differential – PBP | DIFF |
| 22 | Gratuity Pay | GRA |
| 23 | Token | TOKEN |

23 types total. (The earlier v1 template's INSTRUCTIONS sheet said "22"
— that was a typo; this list is canonical.)

**COSDIF carries a batch letter** like every other type. (The
naming-convention sheet omitted it; confirmed typo.)

### 0.5 Batch-letter convention — **LOCKED**

The batch letter `[L]` resets to `A` at the start of each month for
each payroll type, scoped to `(month, payroll-type)`.

**Mode 1 — Sequential (applies to all types except PBP and COS):**
First batch of the month = `A`; subsequent batches the same month =
`B`, `C`, …

**Mode 2 — Quincena-keyed (applies to PBP and COS only):**
- `A` = 1st Quincena (first-half-of-month payroll).
- `B` = 2nd Quincena (second-half-of-month payroll).
- **Sub-batches (hold release):** see §5. Format pending reconciliation
  between two answers given during planning — see `OPEN_ITEMS.md` #C1.

The system auto-suggests the next letter at batch creation time based
on existing batches in `Master_Payroll_Batches` for the same `(month,
payroll-type)`. Maker may override; Admin approval for any override
that breaks monotonic sequence.

**Open:** do PBPOT, COSOT, COSDIF, DIFF follow Mode 1 or Mode 2 of
their parents? **Resolved: Mode 1 (sequential).** Only the strict
quincena payrolls (PBP, COS themselves) use Mode 2.

---

## 1. Workflow — 9 phases — **LOCKED**

```
Phase 1  UPLOAD                ComBen Maker uploads simple 3-col file + supporting docs + selects payroll type
Phase 2  REVIEW & HOLD         Interactive table; mark holds (PBP/COS only); reconcile totals; soft-warn 6-figure PBP/COS
Phase 3  FINDES GENERATION     Account #s pulled from Payee_Database (single source of truth, padded to 10 digits)
Phase 4  AUTHORIZER EMAIL      Summary + held names + supporting docs + FINDES link. NO Annex H yet.
Phase 5  WEACCESS (EXTERNAL)   ComBen uploads FINDES to WeAccess; Authorizers approve there; bank executes
Phase 6  CM UPLOAD & CROSS-REF Upload Credit Memo xlsx → parse → match destination acct ↔ batch payees → integrity report
Phase 7  PAYEE NOTIFICATIONS   Queued send (GmailApp, 50/min trigger). TX date/time pulled from CM. Per-type body.
Phase 8  ANNEX H GENERATION    Generated from confirmed-paid records only. Filed to Drive. (Post-process, COA compliance.)
Phase 9  ACCOUNTING HANDOFF    Email to Accounting recipients (Config) — summary + all files for liquidation
```

### State machine — `Master_Payroll_Batches.Status`

```
Draft
  → Pending Approval         (after Phase 4)
  → Bank Processing          (after Phase 5 — WeAccess upload acknowledged)
  → Bank-Confirmed           (after Phase 6 — CM matched, exceptions resolved/ack'd)
  → Notifications Sent       (after Phase 7 — queue drained)
  → Annex H Generated        (after Phase 8)
  → Forwarded to Accounting  (after Phase 9 — handoff email sent)
  → Closed                   (terminal)
```

Parallel branches:
- `Partially Released - Hold Pending` — when some rows are HOLD, batch
  proceeds with ACTIVE rows; sub-batches close their own state
  machines.
- `Failed - Bank Mismatch` — CM did not match (Phase 6 hard failure).
- `Cancelled` — admin-only state, requires reason and audit entry.

### Per-phase detail (LOCKED)

**Phase 1 — UPLOAD.** Maker fills the upload form (single page):
- Payroll_Type — dropdown of 23 types (§0.4).
- Batch_Letter — radio (A / B / auto-suggest based on Mode 1 or Mode 2).
- Period_Covered — free text (e.g., "April 1-15, 2026").
- Month / Year — auto-filled from today, editable.
- Supporting documents — multi-PDF drop zone (≥1 required).
- Payroll file — drop zone for the 3-column xlsx (§2.1).

**Phase 2 — REVIEW & HOLD.** System parses file, validates every row
against `Payee_Database`, renders interactive table (§13). Maker marks
holds (PBP/COS only), reconciles `Declared_Total` vs computed sum.
"Submit for Approval" disabled until errors = 0 and totals reconcile.

**Phase 3 — FINDES GENERATION.** Triggered by Submit. Account numbers
retrieved from `Payee_Database` keyed on `HRIS_ID`. ACTIVE rows only.
See §10 for the full FINDES spec.

**Phase 4 — AUTHORIZER EMAIL.** Summary email to Authorizers
(§7.1). Contains: batch metadata, totals, **held payee names**, link to
supporting documents folder, link to FINDES file. **No Annex H yet** —
Annex H is post-process per COA compliance flow.

**Phase 5 — WEACCESS.** External step. ComBen Maker uploads the
FINDES CSV to WeAccess (Landbank's portal). Authorizers approve in
WeAccess. Bank executes the transfer. System awaits CM.

**Phase 6 — CM UPLOAD & CROSS-REF.** When Landbank releases the
Credit Memo (CM) xlsx, Maker uploads it. System parses (§4), matches
destination accounts and amounts against the batch roster, surfaces
exceptions. Maker resolves or acknowledges with justification. CM filed
to batch folder as `CM_<BatchNo>_<TRN>.xlsx`.

**Phase 7 — PAYEE NOTIFICATIONS.** Time-driven trigger drains
`Outbound_Email_Queue` at 50/min (well below the 100/day Apps Script
limit when accumulated across the day; 1,500/day on Google Workspace —
safety margin reasonable for 300–1,500 payees per batch). Subject
and body templates are per-payroll-type, pulled from
`Payroll_Types` sheet (editable without code).

**Phase 8 — ANNEX H GENERATION.** Generated only after Phase 6
confirms paid records. Built from the bank-confirmed subset only. PDF
filed to batch folder. Adapted from Treasury's Annex H generator
pattern (Code.gs:676–744) with these ComBen-specific changes:
- BUS / Project Code: blank.
- Nature of Payment: payroll type label.
- Signatory: Treasury's disbursing officer (§7.4, §14).

**Phase 9 — ACCOUNTING HANDOFF.** Handoff email (§7.3) sent to
recipients listed in `Config.Accounting_Recipients`. On send, status →
`Forwarded to Accounting`; on receipt confirmation (manual ack by
Admin in UI), status → `Closed`.

---

## 2. Data model — **LOCKED**

### 2.1 Upload file format

Three columns. No metadata sheet. No instruction sheet.

| Column | Type | Notes |
|---|---|---|
| `HRIS_ID` | text (6 chars, leading zeros preserved) | Lookup key into `Payee_Database`. Normalized to 6-char zero-padded on every read (§11). |
| `HRIS_Name` | text | Compared against master; mismatch surfaced in review UI |
| `Amount` | decimal PHP | Net-pay amount; converted to centavos at FINDES time |

### 2.2 HOT — live Sheets (small, always read)

| Sheet | Purpose | Size |
|---|---|---|
| `Master_Payroll_Batches_<YYYY>` | One row per batch (head only). Yearly partitioned. | Hundreds/yr |
| `Held_Records_Open` | Currently-open holds only. Pruned on release/cancel. | Small |
| `Payroll_Types` | The 23 types + per-type email subject/body templates | 23 |
| `Authorizers` | Authorizer roster + emails | ~5 |
| `User_Database` | Login credentials (SHA256 hashed) | <50 |
| `Config` | System config (root folder IDs, signatories, recipients) | <50 |
| `Outbound_Email_Queue` | Pending emails. Pruned after send. | <2k transient |
| `HRIS_Pending_Changes` | Pending enrollment requests. Pruned on approval/rejection. | Small |
| `_Setup_Log` | Schema bootstrap audit | Few hundred |

#### `Master_Payroll_Batches_<YYYY>` columns

```
Batch_No, Parent_Batch_No, Payroll_Type, Period_Covered, Status,
Active_Count, Hold_Count, Total_Released, Total_Held,
Uploader_Name, Uploader_Email, Created_At,
Line_Items_File_ID, Line_Items_SHA256,
Supporting_Docs_Folder_ID,
FINDES_File_ID, FINDES_SHA256,
CM_File_ID, CM_TRN, Bank_TX_DateTime,
Annex_H_File_ID,
Handoff_Email_Sent_At, Closed_At, Notes
```

### 2.3 COLD — Drive files

| Artifact | Path |
|---|---|
| Line items per batch | `<Batch>/LINE_ITEMS_<BatchNo>.json` |
| Original upload (frozen evidence) | `<Batch>/PAYROLL_UPLOAD_<BatchNo>.xlsx` |
| FINDES CSV | `<Batch>/FINDES_<BatchNo>.csv` |
| Credit Memo | `<Batch>/CM_<BatchNo>_<TRN>.xlsx` |
| Annex H | `<Batch>/Annex_H_<BatchNo>.pdf` |
| Held records report | `<Batch>/Held_Records_Report_<BatchNo>.pdf` |
| Supporting docs | `<Batch>/supporting_docs/` |
| Sub-batches (hold releases) | `<Batch>/_releases/<SubBatchNo>/` |
| Audit log (cold) | `_archive/Audit_Log_<YYYY>.jsonl` |

#### `LINE_ITEMS_<BatchNo>.json` shape

Array of records; each record:

```jsonc
{
  "hris_id": "0677068248",
  "hris_name_file": "ABAYA, NATASHA MICHELLE V.",
  "hris_name_master": "ABAYA, NATASHA MICHELLE V.",
  "name_match": true,
  "amount_php": 12309.95,
  "account_no": "0677125438",
  "email": "abayan@dap.edu.ph",
  "status": "ACTIVE",                  // ACTIVE | HOLD | RELEASED | CANCELLED
  "hold_reason": null,
  "released_in_sub_batch": null,
  "bank_status": null,                 // null | CONFIRMED | NOT_PAID
  "bank_confirmed_at": null,
  "cm_trn": null,
  "notification_sent_at": null,
  "notification_status": null,         // null | QUEUED | SENT | FAILED
  "row_notes": []
}
```

### 2.4 Yearly partitioning

`Master_Payroll_Batches_2026`, `_2027`, … Dashboard reads current year
by default; older years on demand. When a year closes, that sheet
becomes read-only (protected range).

### 2.5 Concurrency

`LockService` per `Batch_No` when mutating line-items JSON or batch row.
Reused pattern from Treasury's `Reconciliation.gs:38`.

---

## 3. Hot / cold lifecycle — **LOCKED**

- **Batch creation:** Phase 1 writes the head row to
  `Master_Payroll_Batches_<YYYY>` (hot) and `LINE_ITEMS_<BatchNo>.json`
  to Drive (cold).
- **Line-items read:** Only loaded when a user opens the batch detail
  view. SHA256 verified on read; mismatch blocks downstream operations
  and alerts admin.
- **Hold release:** Released rows move out of `Held_Records_Open`
  (hot); their `status` in the JSON updates to `RELEASED`; sub-batch
  folder created under `<Batch>/_releases/`.
- **Closure:** When a batch reaches `Closed`, its row remains in
  `Master_Payroll_Batches_<YYYY>` (read-only post year-close). The JSON
  stays in Drive indefinitely.
- **Audit log:** `Audit_Log_<YYYY>` sheet (hot) for current year;
  yearly cron exports to `_archive/Audit_Log_<YYYY>.jsonl` and clears
  the hot sheet on year-rollover.

---

## 4. CM (Credit Memo) cross-reference — **LOCKED**

CM = **Credit Memo** from Landbank, the bank's confirmation of
successful credit to each payee's account. Cross-reference is a
**post-release reconciliation** (Phase 6), not pre-release.

### 4.1 CM file format (Landbank-emitted)

```
Sheet name: <TRN>_P
  Rows 1-13:  Bank metadata
              "Transaction Date: MM/DD/YYYY"
              "Transaction Reference Number: 246-067-260508-60636"
  Row 14:     SOURCE ACCOUNT | DESTINATION ACCOUNT | AMOUNT CREDITED | TRANSACTION DATE/TIME | REMARKS
  Row 15+:    Data rows (accounts as text; amounts in PHP; datetime "05/08/2026 11:46:06 AM")
  Footer:     TOTAL COUNT: N   |   TOTAL AMOUNT DEBITED: ₱
```

**Normalization notes:**
- CM accounts are stored as text and ARE zero-padded — keep as text.
- CM amounts are in PHP (not centavos like FINDES). Convert both sides
  to a common unit before compare.

### 4.2 Match algorithm

For each batch payee (ACTIVE rows only):
- Match on `account_no` (after both sides normalized to 10-char
  zero-padded).
- Verify `amount_php` equality (within centavo tolerance to absorb
  float).

### 4.3 Match table (UI)

```
Batch Payee | Batch Acct | Batch Amt | CM Acct | CM Amt | CM TX DateTime | Match | Action
```

Summary counts at top:
- Matched
- Not in CM (payees the bank did not credit — `bank_status=NOT_PAID`)
- Extra in CM (CM rows not in our batch — `EXTRA_IN_CM` flag)
- Amount mismatches

### 4.4 Gate

"Confirm and proceed to Notifications" enables only when:
- Zero unresolved exceptions, **OR**
- Maker explicitly acknowledges each exception with a one-line
  justification (audited).

On acknowledgment + confirm:
- `LINE_ITEMS_<BatchNo>.json` updated: matched rows get
  `bank_status=CONFIRMED`, `bank_confirmed_at=<CM TX datetime>`,
  `cm_trn=<TRN>`. Unmatched rows get `bank_status=NOT_PAID` and are
  **excluded from notification queue** (Phase 7).
- CM file saved to `<Batch>/CM_<BatchNo>_<TRN>.xlsx`.
- Batch status → `Bank-Confirmed`.

### 4.5 Admin email on exceptions

Per the resolution earlier in this conversation: when exceptions
surface, system emails Admin (user) AND surfaces in UI for Maker to
acknowledge. Acknowledgment + reason logged in `Audit_Log`.

---

## 5. Hold and sub-batch mechanics — **LOCKED (mostly)**

### 5.1 Hold is PBP/COS only

`Hold_Status` is honored only for `Regular Payroll – Plantilla (PBP)`
and `Regular Payroll – COS (COS)`. Other 21 payroll types cannot have
holds — the Hold button in the review UI is disabled.

### 5.2 Hold lifecycle

- Maker marks a row HOLD in Phase 2 with a required `Hold_Reason`.
- HOLD rows are excluded from FINDES (Phase 3) but recorded in
  `Held_Records_Open` (hot) and in the parent batch's JSON with
  `status=HOLD`.
- Authorizer email (Phase 4) includes held payee names + reasons.
- Held rows can later be released via a **sub-batch** that flows
  through its own Phase 3 → Phase 9.

### 5.3 Sub-batch naming — **LOCKED**

Format: **`<BatchNo>_<NN>`** where `<NN>` is a zero-padded
2-digit sequence starting at `02`. Examples:

- Parent batch: `04APBP26`
- First hold release: `04APBP26_02`
- Second hold release: `04APBP26_03`
- …

Rationale for starting `<NN>` at `02`: the parent batch is
implicitly release `01`; sub-batches are subsequent releases of the
same payroll cycle.

Sub-batches inherit their parent's `Payroll_Type` and `Period_Covered`
and reference the parent via `Master_Payroll_Batches_<YYYY>.Parent_Batch_No`.
Sub-batches are stored under `<ParentBatch>/_releases/<SubBatchNo>/` (§6).

---

## 6. Drive folder layout — **LOCKED**

```
<ComBen_Drive_Root>/
├── _archive/                          ← cold audit log JSONL files
├── 2026/
│   ├── 04-April/
│   │   ├── 04APBP26/                  ← parent batch folder
│   │   │   ├── LINE_ITEMS_04APBP26.json
│   │   │   ├── PAYROLL_UPLOAD_04APBP26.xlsx   ← frozen evidence
│   │   │   ├── FINDES_04APBP26.csv
│   │   │   ├── CM_04APBP26_<TRN>.xlsx
│   │   │   ├── Annex_H_04APBP26.pdf
│   │   │   ├── Held_Records_Report_04APBP26.pdf
│   │   │   ├── supporting_docs/
│   │   │   └── _releases/
│   │   │       ├── <SubBatch1>/       ← see §5.3 for naming
│   │   │       └── <SubBatch2>/
│   │   └── 04ARATA26/
│   └── 05-May/
└── 2027/
```

Year and month derived from parsed `Batch_No`. Year folder, month
folder (`<mm>-MonthName`), and batch folder auto-created if missing.

---

## 7. Email templates — **LOCKED**

All templates use Treasury's HTML palette: `#1C2790` (navy) header,
`#CDAE2C` (gold) accent. Stored in `Config.Email_Header_HTML` /
`Config.Email_Footer_HTML` so branding edits don't require code
changes.

### 7.1 Authorizer summary (Phase 4)

- Subject: `[ComBen] Endorsement Request — <BatchNo> (<Payroll Type>)`
- Body: batch metadata, totals (active + held), **held payee names +
  reasons**, link to supporting docs folder, link to FINDES file.
- **No Annex H** (per COA flow — Annex H is post-process).
- Recipients: `Authorizers` sheet.

### 7.2 Payee notification (Phase 7)

- Per-payroll-type subject and body, pulled from `Payroll_Types`
  sheet (editable without code).
- Includes: payee name, payroll-type-specific message, amount, bank
  transaction date/time (from CM), TRN.
- Sent only when `bank_status=CONFIRMED`. NOT_PAID rows are excluded.
- Queued in `Outbound_Email_Queue`, drained by time-driven trigger at
  50/min.

### 7.3 Accounting handoff (Phase 9)

- Subject: `[ComBen] Payroll Disbursement Turned Over for Liquidation — <BatchNo>`
- Body (DAP navy/gold HTML):

```
PAYROLL DISBURSEMENT — TURNED OVER FOR LIQUIDATION

Batch No.:           04APBP26
Payroll Type:        Regular Payroll-Plantilla (1st Quincena)
Period Covered:      April 1-15, 2026
Bank TRN:            246-067-260508-60636
Transaction Date:    May 8, 2026 11:46 AM
Records Paid:        372
Total Disbursed:     PHP 12,345,678.90
Records on Hold:     3 (₱126,400.00 — see hold report)

Attached / Linked:
  • Original Payroll Upload (xlsx)
  • FINDES File (csv)
  • Credit Memo from Landbank (xlsx)
  • Annex H (pdf)
  • Held Records Report (pdf)
  • Supporting Documents (folder link)

This batch is forwarded for liquidation. Please confirm receipt.
```

- Recipients: `Config.Accounting_Recipients` — currently `padillaj@`,
  `preciadosr@`, `baguim@dap.edu.ph`. Stored in Config, not hardcoded.
- After send: batch status → `Forwarded to Accounting`.

### 7.4 Admin alert — CM exceptions

Triggered in Phase 6 when CM cross-reference finds any exception.
Sent to Admin (Config.Admin_Email). Lists batch, exception types and
counts, link to the batch's CM match UI.

---

## 8. Schema bootstrap (`setupComBenSchema()`) — **LOCKED (approach); rows TBD**

### 8.1 Approach

Hybrid: bootstrap script triggered manually by Admin (user). Lives in
the Apps Script project. Run once from the Apps Script editor against
the ComBen-owned spreadsheet.

### 8.2 Behavior

The script:
1. Creates all required sheets if missing (never overwrites existing
   data).
2. Writes header rows with the correct column names.
3. Applies number formats — critically, `@` (text) on every account
   number column to preserve leading zeros forever.
4. Installs data validations (dropdowns: Payroll_Type, Hold_Status,
   etc.).
5. Creates the Drive root folder + Year/Month skeleton for the current
   year.
6. Writes default `Config` rows (placeholders for Admin to fill:
   `Disbursing_Officer_Name`, `Disbursing_Officer_Title`,
   `Authorizers`, `Accounting_Recipients`, root folder IDs, etc.).
7. Logs every action to `_Setup_Log`.

**Idempotent.** Safe to re-run; only adds what is missing.

### 8.3 Companion: `verifyComBenSchema()`

Health-check function listing any missing sheets, columns, or required
config rows. Run before each release. Returns a pass/fail report.

### 8.4 Why not fully manual?

30+ sheets with specific column orders and number formats is too
error-prone to do by hand.

### 8.5 Why not auto-run on first web-app open?

Schema creation is a privileged operation. Admin retains explicit
control over when it fires.

### 8.6 Full sheet/column specification

See `docs/SCHEMA.md`.

---

## 9. Sanity-check policy — **LOCKED**

Scaled back from earlier proposals. **Minimum viable set:**

| Check | Type | Behavior |
|---|---|---|
| `HRIS_ID` exists in `Payee_Database` | Hard block | Anti-tampering — cannot proceed past Phase 2 with unknown IDs |
| Account number normalization (10-char zero-padded text) | Always-on, silent | Applied on every read from `Payee_Database` and every write to FINDES / CM compare |
| `Declared_Total == computed sum(Amount)` | Hard block | Uploader-typed sanity; mismatch prevents Submit |
| 6-figure amount in PBP / COS rows | Soft warn | Yellow flag in UI; Maker clicks "Acknowledge" with one-line note; doesn't block; logged in `Audit_Log` |
| `HRIS_Name` mismatch (file vs master) | Soft warn | Surfaced in review UI; Admin override available; doesn't block |
| `HRIS_ID` has no email in `Payee_Database` | Soft warn (row highlight) | ComBen sees it, can resolve before Submit; not a blocker |

**Explicitly removed** (proposed earlier, dropped per direction):
- Per-payroll-type amount caps.
- Expected record-count ranges per type.
- Duplicate-batch confirmations.
- Fuzzy name-match thresholds (we keep exact match as soft warn only).

---

## 10. FINDES generation — **LOCKED**

### 10.1 Contract

- **One FINDES file per batch.** File saved at
  `<ComBenRoot>/20<yy>/<mm>-MonthName/<BatchNo>/FINDES_<BatchNo>.csv`.
- **One row per payee per FINDES.** ComBen batches are scoped to a
  single earning category, so each employee appears at most once in
  a batch's roster. Duplicate payee names within a batch are a **hard
  error** (§10.5), not an expected case requiring aggregation.
- **ACTIVE rows only.** HOLD rows are excluded.

### 10.2 Single source of truth

One function: `generateFindes(batchNo, opts)` in `Findes.gs`. Both
the sheet-menu entry point and the web app endpoint call this
function. No parallel implementations. (Treasury currently has three
drifted copies; ComBen will not repeat this mistake.)

### 10.3 Account-number lookup

1. Look up account in `Payee_Database` keyed on **`HRIS_ID`** (the
   `HRIS Number` column). Both sides normalized to 6-char zero-padded
   text before compare (§11).
2. If not found → throw with message:
   `"A valid bank account could not be found for HRIS_ID \"<id>\" (\"<name>\"). Please ensure this employee is enrolled in Payee_Database before regenerating."`
3. **No SDO_PCF_Accounts fallback** — PCF and Revolving-Fund flows
   are DV-only and do not exist in ComBen.

### 10.4 Account-number sanity check and padding

```js
const accountStr = String(accountNo);
if (accountStr.length <= 7) {
  throw new Error(
    `Account number for HRIS_ID "<id>" ("<name>") is suspiciously short ` +
    `(${accountStr}). Verify this account in Payee_Database before regenerating.`
  );
}
const finalAccountNo = accountStr.padStart(10, '0');
```

- Hard-stop at length ≤ 7 (likely typo or 3+ missing leading zeros).
- Pad 8- or 9-digit values with leading zeros to width 10 (recovers
  Sheets-stripped leading zeros — see §11).
- **Always run this** — both for menu and web app paths. (Treasury's
  web-app variants currently skip these checks; ComBen does not.)

### 10.5 Duplicate-payee guard

Before writing any row, build a `Set` of `HRIS_ID`s already written.
If an `HRIS_ID` is seen twice in the same batch, abort with:

```
Duplicate HRIS_ID detected in batch <batchNo>: "<id>" ("<name>").
ComBen batches must be one payroll type with no duplicate payees.
Please correct the roster before regenerating.
```

### 10.6 Name cleaning (mirrors Treasury exactly)

```js
let cleanedName = payeeName;
const firstCommaIndex = payeeName.indexOf(',');
if (firstCommaIndex > -1) {
  const surnamePart = payeeName.substring(0, firstCommaIndex + 1);
  const restOfName  = payeeName.substring(firstCommaIndex + 1);
  cleanedName = surnamePart + restOfName.replace(/[.,'-]/g, '');
} else {
  cleanedName = payeeName.replace(/[.,'-]/g, '');
}
cleanedName = cleanedName
  .toUpperCase()
  .replace(/Ñ/g, 'N')
  .replace(/\s+/g, ' ')
  .trim();
```

Rules:

- **First comma preserved** — it is the SURNAME / GIVEN-NAMES
  separator that Landbank parses on.
- Any additional commas → stripped.
- Periods (`.`), single quotes / apostrophes (`'`), hyphens (`-`) →
  stripped throughout.
- `Ñ` / `ñ` → `N`.
- Uppercased.
- Whitespace collapsed (`\s+` → single space), then trimmed.
- If source name contains no comma → whole string is stripped of
  `.,'-` (treated as one token / business name).

**Source of the name:** use `Payee_Database.Payee Name` (master), not
the `HRIS_Name` from the upload file. The upload-file name is for
display + match-check; the master name is canonical for FINDES.

### 10.7 Amount formatting

```js
const formattedAmount = (amount * 100).toFixed(0);   // pesos → centavos
```

Integer centavos, no decimal point, no thousands separator.

### 10.8 CSV row format

```
"<10-digit account>","<cleaned name>",<integer centavos>\n
```

- **Account quoted** to preserve leading zeros across Excel/CSV
  round-trips. (Treasury's web-app variants do not quote; ComBen
  standardizes on quoted.)
- Name quoted.
- Amount unquoted integer.
- Newline `\n` (LF). No trailing newline after the last row.

### 10.9 File save — idempotent

```
<ComBenRoot>/20<yy>/<mm>-MonthName/<BatchNo>/FINDES_<BatchNo>.csv
```

- Year folder, month folder (`<mm>-MonthName`), and batch folder
  created if missing.
- **If `FINDES_<BatchNo>.csv` already exists in the batch folder:**
  rename existing file to `FINDES_<BatchNo>.bak-<YYYYMMDD-HHMMSS>.csv`,
  then write new file. (Treasury currently creates duplicates on
  regenerate; ComBen does not.)
- `Batch_No` format: `[mm][L][CODE][yy]` (§0.4). Parsing extracts
  `mm` (first 2 chars) and `yy` (last 2 chars).

### 10.10 Status update + integrity

After successful save:

- Update `Master_Payroll_Batches_<YYYY>` row for this batch:
  - `FINDES_File_ID = <Drive file ID>`
  - `FINDES_SHA256 = <sha256 of file bytes>`
- Append one `Audit_Log` row:
  `{ ts, actor, action: "FINDES_GENERATED", batchNo, rowCount, fileId, sha256 }`.

---

## 11. Leading-zero handling — **LOCKED**

Two distinct fields are affected. Both have the same root cause
(Sheets numeric coercion on text-like IDs) and the same fix shape
(normalize on every read and write, force `@` text format).

### 11.1 Landbank Account — 10 digits

Confirmed live bug in Treasury's `Payee_Database`:

```
Row 3:  677068248.0     ← stored as number, leading 0 LOST    → should be 0677068248
Row 4:  '5897028915'    ← stored as text, intact              → 5897028915 (no leading 0)
Row 5:  '0677188472'    ← stored as text, leading 0 PRESERVED → 0677188472
Row 2:  1507060419.0    ← number (no leading zero, OK by coincidence)
```

Normalize on every read and write: `String(acct).padStart(10, '0')`.

### 11.2 HRIS Number — 6 digits

Same problem, smaller width. From real `Payee_Database` rows:

```
Row 2:  209803.0   → 209803 (6 digits)
Row 3:  205816.0   → 205816
Row 4:  213646     → 213646  (text)
Row 5:  213649     → 213649
Row 6:  200012.0   → 200012
```

None of the sampled rows currently start with `0`, but the format
permits leading zeros (per project owner). Any future HRIS issued in
the `0xxxxx` range would be silently truncated by Sheets to 5 digits.

Normalize on every read and write: `String(hrisId).padStart(6, '0')`.

### 11.3 Combined policy

| Surface | Account policy | HRIS_ID policy |
|---|---|---|
| `Payee_Database` bridge read | `padStart(10, '0')` | `padStart(6, '0')` |
| Upload file read (HRIS_ID column) | n/a — file doesn't carry account | `padStart(6, '0')` |
| `setupComBenSchema()` | `setNumberFormat('@')` on Account cols | `setNumberFormat('@')` on HRIS_ID cols |
| FINDES writer (§10) | 10-char string, always | n/a — FINDES output has no HRIS column |
| CM parser (§4) | Normalize destination accounts | n/a |
| Enrollment module (§15) | Pad before write | Pad before write |

### 11.4 Admin health panel

Health panel shows:
- Count of `Payee_Database` rows whose `Landbank Account` stored
  representation differs from `padStart(10, '0')` form.
- Count of `Payee_Database` rows whose `HRIS Number` stored
  representation differs from `padStart(6, '0')` form.
- "Heal" button (admin-only) rewrites the offending cells as text
  through the bridge (§15). Each healed row gets a `Healed_At`
  timestamp in the audit ledger.

---

## 12. File browser (in-webapp) — **LOCKED**

New "Files" tab in the dashboard.

- Default tree view: Year → Month → Batch.
- Breadcrumb at top, back button, search box.
- Per folder: list contents with file-type icon, name, size, last
  modified, and actions: `Open in Drive` / `Download` / `Preview`.
- PDF preview inline (iframe to Drive viewer URL).
- Filters: file type (Annex H only, FINDES only, supporting docs only),
  date range, batch number contains.
- Powered by Drive API `files.list` with `q=` queries scoped to the
  ComBen root folder.
- Permissions inherited from Drive ACL — anyone the ComBen Drive root
  is shared with sees the same files in the browser. No extra ACL
  layer to manage.
- Behind the same role-gating as the rest of the dashboard (§14).

---

## 13. M&E surface — **LOCKED**

The Phase 2 review table is the **same UI** used for M&E. Same table
component, loaded read-only after submit, showing payment status per
row.

Columns shown vary by batch stage:

| Stage | Columns shown |
|---|---|
| Phase 2 (Review) | Row, HRIS_ID, HRIS_Name (file), HRIS_Name (master), Amount, Match, Status (Active/Hold), Actions (Hold/Edit) |
| Phase 4–5 (Pending) | Above + FINDES inclusion flag |
| Phase 6 (CM cross-ref) | Above + CM Acct, CM Amt, CM TX DateTime, Match |
| Phase 7+ (Notifications) | Above + Notification Status (Queued/Sent/Failed), Sent At |
| Closed (M&E) | Read-only, all columns, hold-resolution history per row |

One UI does double duty. No separate M&E dashboard module to build
and maintain.

---

## 14. Security model — **LOCKED**

### 14.1 Roles

| Role | Capabilities |
|---|---|
| **Maker (ComBen)** | Upload, review, hold, submit, CM upload, payee enrollment add |
| **Admin (user)** | All Maker capabilities + approve/reject enrollment changes, CM exception override, schema bootstrap, health panel, audit review |
| **Authorizer (Treasury)** | Receive Phase 4 endorsement email; approve in WeAccess (external — outside this system) |
| **Accounting** | Receive Phase 9 handoff email; confirm receipt in UI (sets Closed) |

### 14.2 Disbursing authority

Even though ComBen operates this system, **Treasury remains the
disbursing authority**. The system runs under ComBen's GSuite (emails
come from them, Drive lives under them), but Annex H asserts
Treasury's certification. Modeled explicitly via Config:

```
Config.Disbursing_Officer_Name  = "Maria Monica O. Talan"
Config.Disbursing_Officer_Title = "<Treasury title>"
```

Annex H PDF signs against these values. Audit trail records that
Annex H was generated by ComBen for and on behalf of Treasury.

### 14.3 Authentication

- Login + session module ported from Treasury (Code.gs:1079).
- SHA256 password hashing.
- `User_Database` sheet holds users + role + hashed password.

### 14.4 Trust boundaries

- **Client-side trust: none.** Every action server-validates role +
  state-machine legality.
- **Account numbers never client-supplied.** Always retrieved from
  `Payee_Database` server-side.
- **State transitions enforced server-side.** UI buttons can be
  inspected/modified by user; server checks `Status` precondition for
  every mutation.
- **Audit trail.** Every write logged with `ts`, `actor`, `action`,
  `target`, `before`, `after`.

### 14.5 Integrity (anti-tampering)

- SHA256 of `LINE_ITEMS_<BatchNo>.json` stored in batch row.
- SHA256 of `FINDES_<BatchNo>.csv` stored in batch row.
- Re-verified on every read of those files; mismatch blocks
  downstream operations and alerts Admin.
- We can't prevent download + offline edit, but we can detect
  substitution in our system.
- `LockService` per `Batch_No` for concurrency safety.

---

## 15. Payee enrollment module — **LOCKED (rules); UI TBD**

Scope (from §0.1):

- **ADD payee:** Maker writes directly to Treasury-owned
  `Payee_Database` (auto-approved). Logged in `Audit_Log` and
  `HRIS_Pending_Changes` (with status `AUTO_APPROVED`) for audit
  visibility.
- **REMOVE payee:** Maker request → Admin approval required → write.
- **MODIFY name, account number, or Landbank account:** Maker request
  → Admin approval required → write.

All writes pass through the account normalizer (§11) before commit.

`HRIS_Pending_Changes` columns:

```
Request_ID, Requested_At, Requested_By, Action (ADD/REMOVE/MODIFY),
HRIS_ID, Before_JSON, After_JSON, Status (PENDING/APPROVED/REJECTED/AUTO_APPROVED),
Decision_At, Decision_By, Decision_Note
```

**Write mechanism into Treasury's spreadsheet — LOCKED:**
**Option (b) — Treasury-exposed bridge web app.** Treasury publishes a
small Apps Script web app (`PayeeDatabaseBridge.gs` in the Treasury
repo) that exposes:

- `GET ?op=lookup&hris_id=<id>` — returns the canonical record
  (read-only).
- `POST ?op=add` — body `{ requester, hris_id, name, account, email }` →
  appends to `Payee_Database`. Returns success + new row index.
- `POST ?op=modify` — body `{ requester, hris_id, before, after }` →
  applies the change. Caller (ComBen) is responsible for having
  already obtained Admin approval before calling this.
- `POST ?op=remove` — body `{ requester, hris_id, reason }` → marks
  row removed (soft delete preferred — adds `Removed_At` column).

All POST endpoints:
- Require a shared secret in the `Authorization` header (stored in
  `Config.Treasury_Bridge_Token` on the ComBen side, hardcoded
  via Script Properties on the Treasury side — **never committed**).
- Server-side normalize account numbers per §11.
- Append an entry to Treasury's own audit log AND return the entry
  for ComBen to log on its side (double-ledger).
- Use `LockService` on `Payee_Database` writes.

ComBen calls these endpoints via `UrlFetchApp.fetch(...)` from
`PayeeDatabaseBridge.gs` (client-side) in the ComBen repo. The
ComBen-side wrapper handles retry on 5xx, logs every call to
`Audit_Log`, and surfaces failure to Admin.

Rationale: cleanest separation of ownership (Treasury controls writes
to its own database), explicit audit trail on both sides, no shared
edit access to the Treasury spreadsheet (which would also expose
Treasury's other sheets).

---

## 16. Annex H generation — **LOCKED**

Reference template: `proposals/ANNEX_H_TEMPLATE.xlsx` (committed alongside
this spec).

### 16.1 Reference per COA

Form title: **"DAILY REPORT OF E-PAYMENTS FROM AGENCY ACCOUNT
(ANNEX H OF COA CIRCULAR 2021-014)"**

### 16.2 Header fields

| Field | Source | Example |
|---|---|---|
| `Date` | Bank transaction date from CM (Phase 6) | `2025-06-18` |
| `Report No.` | Auto-generated, format `<YYYY>-<MM>-<NNN>` where `NNN` is a monthly Annex-H counter | `2025-06-010` |
| `Bank Name` | `Config.Annex_H_Bank_Name` | `Landbank of the Philippines, Pasig Capitol Branch` |
| `Sheet No.` | `<n.0>` of `<total.0>` (pagination support) | `1.0` |

`Report No.` counter resets per month and is incremented atomically
under `LockService` on Annex-H generation.

### 16.3 Body columns

```
e-Payment Details                                  | Payee | DV/Payroll No. | BUS No. | Project Code | Nature of Payment | Amount
  Date | Issuer | Transaction Reference Number     |       |                |         |              |                   |
```

| Column | ComBen source |
|---|---|
| `Date` (e-Payment Details) | Bank TX date from CM (per row) |
| `Issuer` | `Config.Annex_H_Issuer` (e.g., `DAP`) |
| `Transaction Reference Number` | `cm_trn` from line item |
| `Payee` | Master `Payee Name` from `Payee_Database` (cleaned per §10.6 if needed for display, but Annex H typically shows mixed-case raw name — confirm during build) |
| `DV/Payroll No.` | `Batch_No` (or `Sub-Batch No.` if this is a release) |
| `BUS No.` | **blank** (ComBen-wide) |
| `Project Code` | **blank** (ComBen-wide) |
| `Nature of Payment` | Payroll-type label from §0.4 (e.g., `Regular Payroll – Plantilla (1st Quincena)`) |
| `Amount` | `amount_php` (PHP, formatted with thousand separator) |

One row per bank-confirmed payee in the batch. Excluded rows:
- `bank_status != CONFIRMED` (NOT_PAID, etc.)
- `status == HOLD` rows from the parent batch (they generate their own
  Annex H when released as sub-batches).

### 16.4 Footer

```
TOTAL: <sum of Amount column>

I HEREBY CERTIFY ON MY OFFICIAL OATH THAT THE ABOVE IS A TRUE STATEMENT
OF ALL E-PAYMENTS DURING THE PERIOD STATED ABOVE IN THE AMOUNTS SHOWN
THEREON.

                                        <Disbursing Officer Name>
                                        NAME AND SIGNATURE OF DISBURSING OFFICER/
                                        CASHIER/AUTHORIZED OFFICER
```

- `<Disbursing Officer Name>`: `Config.Disbursing_Officer_Name`
  (default: `MARIA MONICA O. TALAN`).
- Optional digital signature: if `Config.Disbursing_Officer_Signature_FileId`
  is set, insert image above the name line.

### 16.5 Output

- Generated as PDF from a Google Doc / Sheet template (TBD between the
  two; Sheet template is closer to source — preferred).
- Filed at `<Batch>/Annex_H_<BatchNo>.pdf`.
- `Annex_H_File_ID` written to batch row.
- `LockService` on `Master_Payroll_Batches_<YYYY>` while reserving the
  `Report No.` counter.

### 16.6 Pagination

If row count exceeds the per-page capacity (TBD during build —
estimate ~25 rows per page based on Treasury's Annex H), produce
multiple sheets numbered `1.0` / `2.0` / `<total>.0` in the
`Sheet No.` header. Each sheet has its own footer with totals (page +
running). Final sheet has the certification block.

### 16.7 Adapted from Treasury

Implementation pattern adapted from `Code.gs:676–744`
(Treasury Annex H generator) with these ComBen-specific changes:

- BUS No. / Project Code: always blank.
- DV column → DV/Payroll No. column holds `Batch_No`.
- Nature of Payment → payroll-type label.
- Signatory: from `Config` (decoupled from Treasury's hardcoding).
- Pagination support (Treasury's current generator may handle single
  sheet only — verify and extend).

---

## 17. Code inheritance from Treasury — **LOCKED**

Components to port over (with clearly marked headers in the new repo):

| Component | Treasury source | ComBen target |
|---|---|---|
| Login + session + SHA256 password | `Code.gs:1079` | `Auth.gs` |
| FINDES CSV writer (cleaning, padding, cents) | `Code.gs:298–404` | `Findes.gs` |
| Email HTML templates (palette, header, table styles) | various | `EmailTemplates.gs` + `Config` sheet |
| Annex H generator pattern | `Code.gs:676–744` | `AnnexH.gs` (adapted: blank BUS, payroll-type Nature, Config signatory) |
| Drive folder hierarchy helpers | various | `DriveUtils.gs` |
| LockService reconciliation pattern | `Reconciliation.gs:38` | `Concurrency.gs` |

**Dropped (DV-specific, not needed in ComBen):**
- DV OCR
- JEV parsing
- Tax certificate
- BIR 2307
- SDO_PCF_Accounts
- Refund-of-payment flow

---

## 18. Open items

See `docs/OPEN_ITEMS.md`.
