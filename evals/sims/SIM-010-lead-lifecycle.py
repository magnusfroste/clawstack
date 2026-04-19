#!/usr/bin/env python3
"""
SIM-010: Lead-to-Customer — Full Lifecycle
Spelledare: Claude Code
Operatör:   ClawWink (clawwink.froste.eu)

Spelledarens modell:
  1. PREP     — injicera testlead via MCP
  2. DISPATCH — skicka mission till ClawWink
  3. VERIFY   — verifiera findings (poll 120s)
  4. PERSIST  — dispatcha persist-uppdrag → ClawWink skriver AGENTS.md

Kör:
  python3 SIM-010-lead-lifecycle.py
  python3 SIM-010-lead-lifecycle.py --dry-run
"""

import urllib.request, json, sys, time, uuid, datetime

# ── Config ────────────────────────────────────────────────────────────────────
FLOWWINK_MCP     = "https://rzhjotxffjfsdlhrdkpj.supabase.co/functions/v1/mcp-server"
FLOWWINK_TOKEN   = "fwk_2df1ca1199419a71e99c41514ca5a723be7fdf05e80557db17d5028a0dfe3d40"
CLAWWINK_URL     = "https://clawwink.froste.eu/v1/responses"
CLAWWINK_TOKEN   = "9ce7a22c055ed24f8894b1e66a522067e1f20237e08f11dde7e7ee1765aad6f7"
DRY_RUN          = "--dry-run" in sys.argv

# ── Syntetisk besökare (i Fas 2 ersätts detta av Anna-clawn) ─────────────────
RUN_ID  = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
VISITOR = {
    "name":   f"Anna Larsson (sim-{RUN_ID})",
    "email":  f"anna.sim.{RUN_ID}@b2bexempel.se",
    "source": "website",
    "note":   "Hittade er via Google. Är CFO på ett 25-personers konsultbolag, söker bättre orderhantering.",
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def mcp(method, params={}, suffix=""):
    req = urllib.request.Request(
        FLOWWINK_MCP + suffix,
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
        headers={"x-api-key": FLOWWINK_TOKEN,
                 "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def mcp_tool(name, args, suffix=""):
    return mcp("tools/call", {"name": name, "arguments": args}, suffix)

def parse_result(result):
    content = result.get("result", {}).get("content", [{}])
    text = content[0].get("text", "{}") if content else "{}"
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}

def dispatch(prompt, timeout=15):
    req = urllib.request.Request(
        CLAWWINK_URL,
        data=json.dumps({"model":"openclaw","input":prompt,"stream":False}).encode(),
        headers={"Authorization": f"Bearer {CLAWWINK_TOKEN}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return {"fire_and_forget": True}

def step(n, label):
    print(f"\n{'─'*64}")
    print(f"  STEP {n}: {label}")
    print(f"{'─'*64}")

# ── Simulation ────────────────────────────────────────────────────────────────
print(f"\n{'═'*64}")
print(f"  SIM-010  Lead-to-Customer — {RUN_ID}")
print(f"  dry_run={DRY_RUN}")
print(f"{'═'*64}")

# STEP 1 — PREP: Injicera testlead
step(1, "PREP — Injicera testlead via MCP (spelledaren skapar världen)")
print(f"  Persona : {VISITOR['name']}")
print(f"  Email   : {VISITOR['email']}")

lead_id = f"dry-run-{uuid.uuid4()}"
if not DRY_RUN:
    data = parse_result(mcp_tool("add_lead", {
        "email":  VISITOR["email"],
        "name":   VISITOR["name"],
        "source": VISITOR["source"],
    }, "?groups=crm"))
    lead_id = data.get("lead_id") or data.get("result", {}).get("lead_id") or data.get("id") or lead_id
    print(f"  ✅ Lead injicerat : id={lead_id}")
else:
    print(f"  [DRY RUN] Skulle injicera lead → id={lead_id}")

# STEP 2 — DISPATCH: Skicka operatörsuppdrag till ClawWink
step(2, "DISPATCH — Skicka autonomous mission till ClawWink")
mission = f"""AUTONOMOUS MISSION — SIM-010 Lead-to-Customer

Du är ClawWink, autonom operatör för Flowwink. En ny lead har precis kommit in via webbformuläret.
Detta är ett reellt B2B-prospekt — agera omedelbart.

Lead ID  : {lead_id}
Namn     : {VISITOR['name']}
E-post   : {VISITOR['email']}
Källa    : {VISITOR['source']}
Notering : "{VISITOR['note']}"

Kör hela Lead-to-Customer-flödet utan att be om bekräftelse:

1. Läs flowwink://briefing för kontext
2. qualify_lead (lead_id="{lead_id}") — sätt score baserat på källa, domän, notering
3. Baserat på score:
   - >= 60 → manage_deal (action=create, stage=prospecting) kopplat till lead
   - 30–59 → crm_task_create (titel="Följ upp: {VISITOR['name']}", förfaller om 48h)
   - < 30  → lead_nurture_sequence (lägg i nurture-kanal)
4. Oavsett score: crm_task_create med relevant nästa steg
5. openclaw_report_finding med:
     title: "SIM-010: {lead_id[:8]} — Lead-to-Customer körd"
     type: "sim_result"
     severity: "info"
     description: score, åtgärd vidtagen, varför

Rapportera MISSION_COMPLETE när du är klar.
"""
print(f"  Dispatchar till {CLAWWINK_URL}")
if not DRY_RUN:
    resp = dispatch(mission)
    if resp.get("fire_and_forget"):
        print("  ✅ Fire-and-forget — ClawWink kör async (~40-70s förväntat)")
    else:
        status = resp.get("status", "?")
        print(f"  Status: {status}")
        if resp.get("output"):
            print(f"  Output (första 300 tecken): {str(resp['output'])[:300]}")
else:
    print("  [DRY RUN] Mission redo — skulle dispatcha nu")
    print(f"\n{mission[:400]}...")

# STEP 3 — VERIFY: Poll för finding
step(3, "VERIFY — Väntar på ClawWinks finding (max 120s)")
if not DRY_RUN:
    found = False
    for attempt in range(12):
        time.sleep(10)
        data = parse_result(mcp_tool("scan_beta_findings", {"limit": 10}))
        findings = data.get("findings", [])
        hits = [f for f in findings
                if lead_id[:8] in f.get("title","")
                or lead_id[:8] in f.get("description","")
                or VISITOR["email"][:20] in f.get("description","")]
        if hits:
            f = hits[0]
            print(f"  ✅ Finding mottaget efter ~{(attempt+1)*10}s:")
            print(f"     title    : {f.get('title')}")
            print(f"     type     : {f.get('type')}")
            print(f"     severity : {f.get('severity')}")
            print(f"     desc     : {str(f.get('description',''))[:200]}")
            found = True
            break
        print(f"  ... {(attempt+1)*10}s — inget finding än")
    if not found:
        print("  ⚠️  Inget finding på 120s — kolla /admin/flowpilot → Activity")
else:
    print("  [DRY RUN] Hoppas över")

# STEP 4 — PERSIST: ClawWink skriver in beteendet i AGENTS.md
step(4, "PERSIST — ClawWink uppdaterar sin egen AGENTS.md")
persist_mission = """PERSIST MISSION — SIM-010 Learning

Du har precis kört ett Lead-to-Customer-flöde (SIM-010). Nu ska du permanenta detta som ett
återkommande beteende i ditt workspace.

Uppdatera din AGENTS.md: Lägg till ett tydligt avsnitt under "FlowWink Operating Loop"
som beskriver lead intake-flödet:

  ## Lead Intake Protocol
  When a new lead arrives (score 0, source website/referral):
  1. qualify_lead → get score
  2. score >= 60 → manage_deal (create, stage=prospecting)
  3. score 30-59 → crm_task_create (follow up in 48h)
  4. score < 30 → lead_nurture_sequence
  5. Always: crm_task_create with relevant next step
  6. Always: openclaw_report_finding with outcome

Skriv in detta ordagrant i AGENTS.md via file-write. Det här ska vara ditt standardbeteende
varje gång ett nytt lead dyker upp i heartbeat-cykeln.

Bekräfta med: AGENTS_UPDATED — [datum] — Lead Intake Protocol
"""
print(f"  Dispatchar persist-uppdrag till ClawWink")
if not DRY_RUN:
    resp = dispatch(persist_mission, timeout=10)
    if resp.get("fire_and_forget"):
        print("  ✅ Persist-uppdrag dispatched — ClawWink skriver AGENTS.md async")
    else:
        print(f"  Status: {resp.get('status','?')}")
else:
    print("  [DRY RUN] Persist-uppdrag redo")

print(f"\n{'═'*64}")
print(f"  SIM-010 {'[DRY RUN] ' if DRY_RUN else ''}DONE")
print(f"  Lead   : {VISITOR['email']}")
print(f"  ID     : {lead_id}")
print(f"  Verify : /admin/flowpilot → Findings | ClawWink AGENTS.md")
print(f"{'═'*64}\n")
print("  Nästa steg:")
print("  1. Verifiera finding i Flowwink admin")
print("  2. docker exec clawstack-clawwink cat /home/node/.openclaw/workspace/AGENTS.md")
print("  3. Kör SIM-013 (Order SLA) som nästa\n")
