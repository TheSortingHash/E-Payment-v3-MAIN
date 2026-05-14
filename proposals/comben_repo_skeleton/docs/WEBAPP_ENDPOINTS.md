# ComBen — Web app endpoint map

> **Status:** Stub. To be filled during SPEC walkthrough.

For each endpoint, capture:

- Role required (Maker / Admin / Authorizer / Accounting / public)
- HTTP semantics (`doGet` route param vs. `google.script.run` server fn)
- Input shape
- Output shape
- Side effects (sheet writes, Drive writes, emails sent, audit entries)
- Error modes

## Endpoint groups

- **Maker** — roster intake, batch assembly, FINDES generation request, hold/release actions
- **Admin** — config edits, schema bootstrap, exception overrides, audit review
- **Bridge** — read-only Payee_Database lookup, CM cross-reference fetch
- **Accounting** — handoff acknowledgment, archive access

**[TO BE DRAFTED]**
