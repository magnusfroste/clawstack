# ClawStack Evals

ClawStack owns all simulation definitions and eval results.
FlowWink (and any other SaaS) is the target — the "claws" ClawThree operates.

## Structure

```
evals/
  sims/        Python scripts that dispatch missions to ClawThree via /v1/responses
  scenarios/   Human-readable scenario definitions and results from past runs
  results/     Raw output logs from simulation runs
```

## Simulations

| ID | Name | OBJ | Status |
|----|------|-----|--------|
| SIM-001 | Lead qualification + order fulfillment | OBJ-002/003 | ✅ 2026-04-15 |
| SIM-002 | Business process audits | OBJ-001/002/005 | ✅ 2026-04-15 |
| SIM-008 | Full lead lifecycle — visitor → operator | OBJ-003 | ✅ 2026-04-17 |
| SIM-009 | Q2C — order → invoice | OBJ-002 | ✅ 2026-04-17 |
| SIM-010 | Lead lifecycle — qualify → outreach/task | OBJ-003 | 🔲 TODO |
| SIM-011 | Expense compliance — VAT audit | OBJ-005 | 🔲 TODO |
| SIM-012 | Content — missing meta descriptions | OBJ-001 | 🔲 TODO |
| SIM-013 | Booking utilization — services without availability | OBJ-004 | 🔲 TODO |

## How to run

```bash
python3 evals/sims/SIM-009-q2c-invoice.py
python3 evals/sims/SIM-008-lead-lifecycle.py
python3 evals/sims/SIM-008-lead-lifecycle.py --dry-run
```

## Architecture

```
ClawStack (eval owner)
  dispatch mission → ClawThree /v1/responses
    ClawThree reasons + acts via FlowWink MCP
      findings → FlowWink beta_test_findings
        visible in /admin/flowpilot → Findings
```
