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
| SIM-009b | MCP write audit — 67 tools, 10/10 write | OBJ-001/002 | ✅ 2026-04-17 |
| SIM-009c | Autonomous blog from live business data | OBJ-001 | ✅ 2026-04-17 |
| SIM-010 | Lead lifecycle — qualify → deal → CRM-task | OBJ-003 | ✅ 2026-04-19 (partial — UUID bug fixad) |
| SIM-011 | Stale deal reactivation — pipeline health | OBJ-003 | ✅ 2026-04-19 |
| SIM-012 | Content — gap detection + audit | OBJ-001 | 🔲 TODO |
| SIM-013 | Booking utilization — services without availability | OBJ-004 | 🔲 TODO |
| SIM-014 | Procure-to-Pay — inköpscykel (PO → goods receipt) | OBJ-005 | 🔲 TODO |
| SIM-015 | Record-to-Report — COO veckodigest | OBJ-001/005 | 🔲 TODO |
| SIM-016 | Full Q2C — lead → quote → e-sign → invoice → Stripe payment | OBJ-002/003 | 📝 Draft |
| SIM-017 | Bank reconciliation — Stripe payouts → auto-match → unmatched reasoning | OBJ-005 | 📝 Draft |
| SIM-018 | Timesheet to Invoice — konsultflödet med kontext-bedömning | OBJ-002/005 | 📝 Draft |

## How to run

```bash
python3 evals/sims/SIM-009-q2c-invoice.py
python3 evals/sims/SIM-008-lead-lifecycle.py
python3 evals/sims/SIM-008-lead-lifecycle.py --dry-run
```

## Agent vs. Automation — sim-designprincipen

Varje sim ska explicit svara på: *vad gör agenten här som ett klassiskt workflow/RPA inte kan?*

Typiska agent-fördelar att luta sig mot:
- Kontextuell bedömning (inte tröskelregel)
- Tvärmodul-korrelation (expense + kontrakt + order i ett svep)
- Frånvaroanalys (reagerar på att ingenting finns)
- Strukturell anomalidetektering (dubbletter, semantiska fel)
- Conditional non-action (fakturerar INTE när förutsättningarna saknas)

Se `research/2026-04-19-agent-vs-automation-live-proof.md` för live-bevis.

## Architecture

```
ClawStack (eval owner)
  dispatch mission → ClawWink /v1/responses
    ClawWink reasons + acts via FlowWink MCP
      findings → FlowWink beta_test_findings
        visible in /admin/flowpilot → Findings
```
