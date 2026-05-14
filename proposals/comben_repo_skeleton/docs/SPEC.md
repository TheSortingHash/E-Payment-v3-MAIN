# E-Payment-ComBen-v1 — Specification

> **Status:** Draft. Sections marked **[TO BE DRAFTED]** require walkthrough
> with the project owner before they are filled in. Do not implement against
> this document until every section is marked **Locked**.

## 0. Scope and non-goals — **LOCKED**

### 0.1 In scope

- Disbursement of compensation & benefits payroll items to government
  employees via Landbank FINDES upload.
- One payroll type per batch (per the canonical table in §0.4).
- End-to-end workflow: roster intake → validation → batch assembly →
  FINDES generation → endorsement → CM cross-reference → release →
  accounting handoff → archival.
- Roles: Maker, Admin, Authorizer, Accounting.
- Google Sheets backend + Apps Script web app + Google Drive for
  artifacts.
- **Payee enrollment module** inside ComBen web app:
  - **ADD payee:** Maker writes directly to `Payee_Database` (auto-allowed).
  - **REMOVE payee:** requires Admin approval.
  - **MODIFY name, account-number, or Landbank account:** requires Admin
    approval.
  - All writes target Treasury-owned `Payee_Database` (§0.3).

### 0.2 Non-goals

- DV-style disbursements — handled by Treasury E-Payment v3.
- PCF replenishment / Revolving Fund establishment — DV-only.
- Tax / GSIS / PhilHealth / Pag-IBIG deduction computation. **ComBen
  receives net-pay amounts** already computed upstream by HR/Payroll.
- General-ledger posting — ComBen produces the handoff package;
  Accounting team posts in their own system.

### 0.3 Payee_Database ownership — **LOCKED**

- **Treasury owns `Payee_Database`.**
- ComBen's enrollment module writes into Treasury's `Payee_Database`
  (shared spreadsheet, or bridge service — mechanism deferred to
  `OPEN_ITEMS.md`).
- Read path: ComBen reads the same `Payee_Database` for FINDES account
  lookup (§10.3).

### 0.4 Canonical payroll types and batch codes — **LOCKED**

Batch number format: `[mm][L][CODE][yy]`

- `[mm]` — 2-digit month (`01`–`12`)
- `[L]`  — batch letter (see §0.5)
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

**Note on COSDIF:** the source naming-convention sheet showed `[mm]COSDIF[yy]`
(no batch letter). This was a typo in the sheet; COSDIF **does take a
batch letter** like every other payroll type, i.e., `[mm][L]COSDIF[yy]`.

### 0.5 Batch-letter convention — **LOCKED**

The batch letter `[L]` resets to `A` at the start of each month for each
payroll type, scoped to `(month, payroll-type)`. So `05ART26` and `05APEI26`
both legitimately start at `A` in May 2026 — they are independent counters.

Two assignment modes:

**Mode 1 — Sequential (default, applies to all payroll types except
Regular Payroll – Plantilla and Regular Payroll – COS):**

- First batch of the month: `A`.
- Subsequent batches the same month: `B`, `C`, …

**Mode 2 — Quincena-keyed (applies to Regular Payroll – Plantilla
[PBP] and Regular Payroll – COS [COS]):**

- `A` = 1st Quincena (first-half-of-month payroll).
- `B` = 2nd Quincena (second-half-of-month payroll).
- **Sub-batches:** if the 1st Quincena needs to be split (e.g., a held
  group released later), append an additional letter to form
  `AA`, `AB`, `AC`, …; same pattern for 2nd Quincena
  → `BA`, `BB`, `BC`, …

The system auto-suggests the next letter at batch creation time based
on existing batches in `Master_Payroll_List` for the same `(month,
payroll-type)`. Maker may override; Admin approval required for any
override that breaks monotonic sequence.

**Open:** do **Overtime – Plantilla (PBPOT)** and **Overtime – COS (COSOT)**
follow Mode 1 or Mode 2? Same question for the Differentials (DIFF,
COSDIF). Logged in `OPEN_ITEMS.md`.

## 1. Workflow — 9 phases

**[TO BE DRAFTED]**

Phases (placeholder titles — confirm during walkthrough):

1. Roster intake
2. Validation
3. Payee enrollment check
4. Batch assembly
5. FINDES generation
6. Endorsement / authorizer request
7. Cash Management (CM) cross-reference
8. Release / Landbank upload
9. Accounting handoff & archival

## 2. Data model

**[TO BE DRAFTED]**

Anticipated sheets:

- `Master_Payroll_List` (hot) — active batch rows
- `Archive_Payroll_List` (cold) — completed-batch rows moved out of hot
- `Payee_Database` (bridge) — read-only mirror or shared link to Treasury's Payee_Database
- `Config` — Script-Properties-backed config, plus visible settings
- `Audit_Log` — append-only event log

## 3. Hot / cold lifecycle

**[TO BE DRAFTED]**

## 4. CM cross-reference

**[TO BE DRAFTED]**

**Decision logged:** when CM cross-reference finds exceptions (unmatched
records, extra records, amount mismatches), the system **emails the
admin** AND surfaces the exceptions in the Maker UI, which the Maker must
**acknowledge with a written reason** before the batch can proceed.
Acknowledgment + reason are written to `Audit_Log`.

## 5. Hold and sub-batch mechanics

**[TO BE DRAFTED]**

## 6. Drive folder layout — **LOCKED (structure); contents TBD**

```
<ComBenRoot>/
  20<yy>/
    <mm>-MonthName/
      BATCH-<batchNo>/
        FINDES-<batchNo>.csv
        PayrollRegister-<batchNo>.pdf
        Endorsement-<batchNo>.pdf
        ... (other batch artifacts, TBD)
```

Year and month are derived from the parsed `batchNo` (§0.4 format).
Example for `04BRT26`:

```
<ComBenRoot>/2026/04-April/BATCH-04BRT26/FINDES-04BRT26.csv
```

## 7. Email templates

**[TO BE DRAFTED]**

Templates to draft:

- Endorsement request (to authorizers)
- CM exception alert (to admin)
- Release confirmation
- Accounting handoff (new — not present in Treasury system)

## 8. Schema bootstrap (`setupComBenSchema()`)

**[TO BE DRAFTED]** — pseudo-code listing every sheet, column, number
format, validation, frozen-row count.

## 9. Sanity-check policy

**[TO BE DRAFTED]** — including:

- Account-number length floor (mirror Treasury's `length <= 7` hard-stop).
- Leading-zero recovery via `padStart(10, '0')`.
- Duplicate-payee guard within a batch (see §10).

## 10. FINDES generation **— LOCKED**

### 10.1 Contract

- **One FINDES file per batch.** File saved at
  `<ComBenRoot>/YYYY/MM-MonthName/BATCH-<batchNo>/FINDES-<batchNo>.csv`.
- **One row per payee per FINDES.** ComBen batches are scoped to a single
  earning category, so each employee appears at most once in a batch's
  roster. Duplicate payee names within a batch are a **hard error** (see
  §10.5), not an expected case requiring aggregation.

### 10.2 Single source of truth

One function: `generateFindes(batchNo, opts)` in `Findes.gs`. Both the
sheet-menu entry point and the web app endpoint call this function. No
parallel implementations. (Treasury currently has three drifted copies;
ComBen will not repeat this mistake.)

### 10.3 Account-number lookup

1. Look up account in `Payee_Database` keyed on `Payee Name`.
2. If not found → throw with message:
   `"A valid bank account could not be found for \"<name>\". Please ensure they are enrolled in Payee_Database before regenerating."`
3. **No SDO_PCF_Accounts fallback** — PCF and Revolving-Fund flows are
   DV-only and do not exist in ComBen.

### 10.4 Account-number sanity check and padding

```js
const accountStr = accountNo.toString();
if (accountStr.length <= 7) {
  throw new Error(
    `Account number for "<name>" is suspiciously short (${accountStr}). ` +
    `Verify this account in Payee_Database before regenerating.`
  );
}
const finalAccountNo = accountStr.padStart(10, '0');
```

- Hard-stop at length ≤ 7 (likely typo or 3+ missing leading zeros).
- Pad 8- or 9-digit values with leading zeros to width 10 (recovers
  Sheets-stripped leading zeros).
- **Always run this** — both for menu and web app paths. (Treasury's
  web-app variants currently skip these checks; ComBen does not.)

### 10.5 Duplicate-payee guard

Before writing any row, build a `Set` of payee names already written. If
a name is seen twice in the same batch, abort with:

```
Duplicate payee detected in batch <batchNo>: "<name>".
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

- **First comma preserved** — it is the SURNAME / GIVEN-NAMES separator
  that Landbank parses on.
- Any additional commas → stripped.
- Periods (`.`), single quotes / apostrophes (`'`), hyphens (`-`) →
  stripped throughout.
- `Ñ` / `ñ` → `N`.
- Uppercased.
- Whitespace collapsed (`\s+` → single space), then trimmed.
- If source name contains no comma → whole string is stripped of
  `.,'-` (treated as one token / business name).

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
<ComBenRoot>/YYYY/MM-MonthName/BATCH-<batchNo>/FINDES-<batchNo>.csv
```

- Year folder, month folder (`MM-MonthName`), and batch folder
  (`BATCH-<batchNo>`) created if missing.
- **If `FINDES-<batchNo>.csv` already exists in the batch folder:**
  rename existing file to `FINDES-<batchNo>.bak-<YYYYMMDD-HHMMSS>.csv`,
  then write new file. (Treasury currently creates duplicates on
  regenerate; ComBen does not.)
- `batchNo` format: `[mm][L][CODE][yy]` (§0.4). Parsing extracts
  `mm` (first 2 chars), `yy` (last 2 chars), and the middle segment
  (letter(s) + code). The 4-digit year resolves as `20<yy>`; month index
  resolves via the `monthNames` array (`mm` 1-indexed).

### 10.10 Status update

After successful save:

- Set `Status = "FINDES Generated"` on every row in `Master_Payroll_List`
  with `Batch No = batchNo`.
- Append one `Audit_Log` row:
  `{ ts, actor, action: "FINDES_GENERATED", batchNo, rowCount, fileId }`.

## 11. Leading-zero handling (cross-cutting)

**[TO BE DRAFTED]** — guidance for Sheets ingestion of payroll uploads,
covering: forced-text format on the account-number column at import
time; warning banner when account-number column shows any value with
length < 10 after import; recovery path via Payee_Database canonical
record.

## 12. File browser

**[TO BE DRAFTED]**

## 13. Monitoring & Evaluation (M&E) surface

**[TO BE DRAFTED]**

## 14. Security model

**[TO BE DRAFTED]** — Maker / Admin / Authorizer / Accounting roles;
Script-Properties-stored secrets; no client-side trust; audit trail
coverage.

## 15. Payee enrollment module — **[TO BE DRAFTED]**

Scope locked (§0.1):

- **ADD payee:** Maker writes directly to Treasury-owned `Payee_Database`
  (auto-approved, but logged in `Audit_Log` with actor + timestamp).
- **REMOVE payee:** request created by Maker, Admin approval required
  before write.
- **MODIFY name, account-number, or Landbank account:** request created
  by Maker, Admin approval required before write.
- Mechanism of write into Treasury-owned spreadsheet TBD (direct
  `openById` write vs. bridge service) — see `OPEN_ITEMS.md`.

## 16. Open items

See `OPEN_ITEMS.md`.
