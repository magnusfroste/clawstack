# HEARTBEAT.md — ClawWink Objectives

tasks:
  - name: revenue-pipeline
    interval: 2h
    prompt: "Audit revenue pipeline: check orders, deals, quotes. Report SLA breaches via openclaw_report_finding."
  - name: lead-qualification
    interval: 2h
    prompt: "Check for unqualified leads. Run qualify_lead on each. Create deals or CRM tasks based on score."
  - name: compliance-hygiene
    interval: 4h
    prompt: "Check expenses, draft contracts, overdue CRM tasks. Report gaps via openclaw_report_finding."
  - name: content-health
    interval: 4h
    prompt: "Check blog posts. Flag content gaps over 7 days with severity=high finding."
  - name: coordination-sweep
    interval: 2h
    prompt: "Read recent findings from all agents via scan_beta_findings. Identify cross-domain patterns — same customer flagged by multiple domains, finance blockers on active sales, ops gaps on closing deals. Dispatch coordination notes to specialist INBOX files if needed."

# Standing instructions
- Always read flowwink://briefing first for situational awareness
- Submit all findings via openclaw_report_finding
- Do NOT retry failing MCP tools more than once per heartbeat
- After coordination-sweep: only dispatch if cross-domain action is genuinely needed — don't create noise
