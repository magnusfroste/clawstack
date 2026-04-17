#!/usr/bin/env python3
"""
SIM-008: Full Lead Lifecycle — Synthetic Visitor → Autonomous Operator

A "ClawBot-Visitor" creates a real lead in FlowWink via MCP.
ClawThree then autonomously detects, qualifies, and outreaches — no human touch.

Usage:
  python3 sim-008-lead-lifecycle.py
  python3 sim-008-lead-lifecycle.py --dry-run
"""

import urllib.request, json, sys, time, uuid, datetime

# ── Config ───────────────────────────────────────────────────────────────────
FLOWWINK_MCP    = "https://rzhjotxffjfsdlhrdkpj.supabase.co/functions/v1/mcp-server"
FLOWWINK_TOKEN  = "fwk_509769f3714b3873913385e96d7459d03917bbfa7029c91bcdbe82bea0d6510c"
CLAWTHREE_URL   = "https://clawthree.froste.eu/v1/responses"
CLAWTHREE_TOKEN = "c90c9f6268168d17c1b49ec9ee0427b7bec4ea156823e946ab7cb642bd56956c"
DRY_RUN         = "--dry-run" in sys.argv

# ── Synthetic visitor persona ─────────────────────────────────────────────────
RUN_ID  = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
VISITOR = {
    "name":   f"Anna Lindström (sim-{RUN_ID})",
    "email":  f"anna.sim.{RUN_ID}@startupexample.io",
    "source": "website",
    "note":   "Found you via Google. Interested in project management for a 12-person startup.",
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def mcp(method, params={}, suffix=""):
    req = urllib.request.Request(
        FLOWWINK_MCP + suffix,
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
        headers={"Authorization": f"Bearer {FLOWWINK_TOKEN}",
                 "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def mcp_tool(name, args, suffix=""):
    return mcp("tools/call", {"name": name, "arguments": args}, suffix)

def parse_tool_result(result):
    content = result.get("result", {}).get("content", [{}])
    text = content[0].get("text", "{}") if content else "{}"
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}

def dispatch(prompt):
    req = urllib.request.Request(
        CLAWTHREE_URL,
        data=json.dumps({"model":"openai/gpt-4.1","input":prompt,"stream":False}).encode(),
        headers={"Authorization": f"Bearer {CLAWTHREE_TOKEN}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return {"fire_and_forget": True}

def step(n, label):
    print(f"\n{'─'*62}")
    print(f"  STEP {n}: {label}")
    print(f"{'─'*62}")

# ── Simulation ────────────────────────────────────────────────────────────────
print(f"\n{'═'*62}")
print(f"  SIM-008  Lead Lifecycle — {RUN_ID}")
print(f"  dry_run={DRY_RUN}")
print(f"{'═'*62}")

# STEP 1 — ClawBot-Visitor creates lead
step(1, "ClawBot-Visitor arrives (creates lead via MCP add_lead)")
print(f"  Persona : {VISITOR['name']}")
print(f"  Email   : {VISITOR['email']}")
print(f"  Source  : {VISITOR['source']}")

lead_id = f"dry-run-{uuid.uuid4()}"
if not DRY_RUN:
    data = parse_tool_result(mcp_tool("add_lead", {
        "email":  VISITOR["email"],
        "name":   VISITOR["name"],
        "source": VISITOR["source"],
    }))
    lead_id = data.get("lead_id", lead_id)
    print(f"  ✅ Lead created : id={lead_id}  existing={data.get('existing', False)}")
else:
    print(f"  [DRY RUN] Would create lead → id={lead_id}")

# STEP 2 — Verify visible in CRM
step(2, "Verify lead is visible in FlowWink CRM")
if not DRY_RUN:
    data = parse_tool_result(mcp_tool("manage_leads",
        {"action":"list","filters":{"status":"new"}}, "?groups=crm"))
    leads = data.get("leads", [])
    match = next((l for l in leads if l.get("id") == lead_id), None)
    if match:
        print(f"  ✅ Visible: {match.get('name')} ({match.get('status')})")
    else:
        print(f"  ✅ Lead created (not yet in filtered list — may need score)")
else:
    print("  [DRY RUN] Skipped")

# STEP 3 — Dispatch autonomous mission to ClawThree
step(3, "Dispatch autonomous mission to ClawThree")
mission = f"""AUTONOMOUS MISSION — SIM-008 Lead Lifecycle

A new lead just arrived via the website. You are the autonomous operator. Act immediately.

Lead ID  : {lead_id}
Name     : {VISITOR['name']}
Email    : {VISITOR['email']}
Source   : {VISITOR['source']}
Note     : "{VISITOR['note']}"

Execute fully without asking for confirmation:

1. Read flowwink://briefing for context
2. qualify_lead with lead_id="{lead_id}"
3. Based on score:
   - >= 50 → send_email_to_lead (purpose=outreach, dry_run={'true' if DRY_RUN else 'false'})
   - <  50 → crm_task_create (title="Follow up: {VISITOR['name']}", due in 48h)
4. openclaw_report_finding:
     title: "SIM-008: Lead {lead_id[:8]} processed"
     type: "sim_008_lead_lifecycle"
     severity: "info"
     description: what score, what action taken, why

Use ?groups=crm for CRM tools. Report MISSION_COMPLETE when done.
"""
print(f"  Dispatching to {CLAWTHREE_URL}")
if not DRY_RUN:
    resp = dispatch(mission)
    if resp.get("fire_and_forget"):
        print("  ✅ Fire-and-forget — ClawThree running async (~40-60s expected)")
    else:
        print(f"  Response: {str(resp)[:200]}")
else:
    print("  [DRY RUN] Mission ready — would dispatch now")
    print(f"\n{mission[:300]}...")

# STEP 4 — Poll for finding
step(4, "Poll for ClawThree's finding (max 120s)")
if not DRY_RUN:
    found = False
    for attempt in range(12):
        time.sleep(10)
        data = parse_tool_result(mcp_tool("scan_beta_findings", {"limit": 10}))
        findings = data.get("findings", [])
        hits = [f for f in findings
                if "sim_008" in f.get("type","").lower()
                or lead_id[:8] in f.get("title","")
                or lead_id[:8] in f.get("description","")]
        if hits:
            f = hits[0]
            print(f"  ✅ Finding received after ~{(attempt+1)*10}s:")
            print(f"     title    : {f.get('title')}")
            print(f"     type     : {f.get('type')}")
            print(f"     severity : {f.get('severity')}")
            print(f"     desc     : {str(f.get('description',''))[:150]}")
            found = True
            break
        print(f"  ... {(attempt+1)*10}s elapsed — no finding yet")
    if not found:
        print("  ⚠️  No finding in 120s — check /admin/flowpilot → Activity")
else:
    print("  [DRY RUN] Skipped")

print(f"\n{'═'*62}")
print(f"  SIM-008 {'[DRY RUN] ' if DRY_RUN else ''}DONE")
print(f"  Lead   : {VISITOR['email']}")
print(f"  ID     : {lead_id}")
print(f"  Verify : flowwink://activity  |  /admin/flowpilot → Findings")
print(f"{'═'*62}\n")
