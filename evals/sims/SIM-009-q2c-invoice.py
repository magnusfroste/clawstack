#!/usr/bin/env python3
"""
SIM-009: Quote-to-Cash — Order → Invoice (OBJ-002)

ClawThree autonomously finds a paid order without invoice,
runs send_invoice_for_order, verifies invoice was created.

Status: ✅ VERIFIED 2026-04-17
  - ClawThree found order 301ebc16 autonomously (no ID given)
  - Invoice 2996ab91 created via send_invoice_for_order
  - Finding reported: missing_data / high
"""

CLAWTHREE_URL   = "https://clawthree.froste.eu/v1/responses"
CLAWTHREE_TOKEN = "53ceb09e279784038470883facb5a139b119eaa3207692843f1cff6a6b291617"

MISSION = """AUTONOMOUS MISSION — SIM-009 Q2C Invoice

1. Read flowwink://briefing
2. List all orders + invoices via MCP
3. Find paid orders missing a linked invoice
4. Run send_invoice_for_order on the first match
5. Verify invoice_id is returned
6. Report finding:
   - type: missing_data, severity: high if invoice was missing
   - type: quality_gap, severity: low if all already invoiced
Report MISSION_COMPLETE with what you found."""
