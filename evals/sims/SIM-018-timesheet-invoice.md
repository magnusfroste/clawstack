# SIM-018: Timesheet to Invoice

> Process: Quote-to-Cash  
> Tidstjuv: Timrapporter omvandlas till fakturor manuellt — felaktigheter missas, betalningar försenas.

---

## Scenario Setup

**What the Narrator Rigs:**
- Create timesheets with some missing contracts
- Include 2-3 timesheets without valid contracts

**What ClawWink Is Expected to Do Autonomously:**
1. Run `timesheet_invoice_check`
2. Verify contract exists for each timesheet
3. Create invoice for valid timesheets
4. Flag timesheets without contracts
5. Report findings with appropriate severity

**Verify:** Invoices created for valid timesheets, missing contracts flagged

**FlowWink Tools:** `timesheet_invoice_check`, `manage_invoices`

**New Modules Required:** Timesheet-to-invoice workflow — **must be built**

---

## Why Not a Workflow?

A classic timesheet automation creates invoices regardless of contract status. The agent understands: should this timesheet be invoiced? Is there a valid contract? Is the client on credit hold? Contextual judgment is the whole point of financial controls.

---

## Expected Findings

**Finding 1: Valid Timesheets Invoiced**
- **Severity:** info
- **Details:** Invoices created for valid timesheets
- **Action:** Invoices sent

**Finding 2: Missing Contracts Flagged**
- **Severity:** medium
- **Details:** Timesheets without valid contracts
- **Action:** Flag for manual review

---

_Next: Update SIM status and commit_
