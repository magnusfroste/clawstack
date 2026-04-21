# SIM-016: Period-End Close (Bokslut)

> Process: Record-to-Report  
> Tidstjuv: Periodavslut är en manuell checklista som tar dagar — obalans i konton hittas för sent.

---

## Scenario Setup

**What the Narrator Rigs:**
- Create transactions with intentional imbalance (one account incorrectly posted)
- Set date = last day of period

**What ClawWink Is Expected to Do Autonomously:**
1. Run `accounting_reports` (BS + P&L)
2. Detect imbalance
3. Propose adjusting journal entry
4. Report finding `critical` with specified discrepancy
5. (If balance OK) Propose period lock

**Verify:** Imbalance detected and correctly reported

**FlowWink Tools:** `accounting_reports`, `manage_journal_entry` + new `period_close_workflow`

**New Modules Required:** Period-end close workflow — **must be built**

---

## Why Not a Workflow?

Period-close is by definition an exception flow full of manual decisions: which entries should be periodized? Is this imbalance a data error or a legitimate entry? Should the period be locked even though a vendor invoice is still missing? That's exactly what an experienced controller does — and what an agent can replicate. No workflow in the world can make that decision.

---

## Expected Findings

**Finding 1: Imbalance Detected**
- **Severity:** critical
- **Details:** Account mismatch found in P&L
- **Action:** Proposed adjusting journal entry

**Finding 2: Period Lock Recommendation**
- **Severity:** info
- **Details:** All accounts balanced, period ready to lock
- **Action:** Recommend period close

---

_Next: Create SIM-017 and SIM-018_
