# E-Payment-ComBen-v1 — Specification

> **Status:** Draft. Sections marked **[TO BE DRAFTED]** require walkthrough
> with the project owner before they are filled in. Do not implement against
> this document until every section is marked **Locked**.

## 0. Scope and non-goals

**[TO BE DRAFTED]**

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

## 6. Drive folder layout

**[TO BE DRAFTED]** — inherits Treasury convention:

```
<ComBenRoot>/
  YYYY/
    MM-MonthName/
      BATCH-<batchNo>/
        FINDES-<batchNo>.csv
        PayrollRegister-<batchNo>.pdf
        Endorsement-<batchNo>.pdf
        ... (other batch artifacts)
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
- `batchNo` format: `YYYY-MM-NNN` (e.g. `2026-05-001`). Parsing
  splits on `-`; month index resolves via the `monthNames` array.

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

## 15. Open items

See `OPEN_ITEMS.md`.
