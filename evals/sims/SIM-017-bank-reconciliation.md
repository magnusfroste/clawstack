# SIM-017: Bank Reconciliation

> Process: Record-to-Report  
> Tidstjuv: Obalans mellan bank och bokförning — 20% av transaktioner matchas inte automatiskt.

---

## Scenario Setup

**What the Narrator Rigs:**
- Create bank transactions with some that don't match accounting entries
- Include 3-5 unmatched transactions (20% of total)

**What ClawWink Is Expected to Do Autonomously:**
1. Run `bank_reconciliation_check`
2. Match bank transactions to accounting entries
3. Identify unmatched transactions (20%)
4. Propose matching suggestions for each
5. Report findings with severity based on amount

**Verify:** Unmatched transactions identified, suggestions provided

**FlowWink Tools:** `bank_reconciliation_check`, `manage_journal_entry`

**New Modules Required:** Bank reconciliation module — **must be built**

---

## Why Not a Workflow?

A classic bank reconciliation automation matches transactions by date and amount only. The agent understands context: is this a legitimate timing difference? Is this a data entry error? Should it be matched to a different transaction? Contextual judgment is the whole point of control environments.

---

## Expected Findings

**Finding 1: Unmatched Transactions**
- **Severity:** high
- **Details:** 20% of transactions unmatched
- **Action:** Proposed matching suggestions

**Finding 2: Reconciliation Complete**
- **Severity:** info
- **Details:** All transactions matched or proposed
- **Action:** Recommend reconciliation close

---

_Next: Create SIM-018_
