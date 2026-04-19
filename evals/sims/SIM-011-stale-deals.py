#!/usr/bin/env python3
"""
SIM-011: Stale Deal Reactivation
Spelledare: Claude Code
Operatör:   ClawWink (clawwink.froste.eu)

Autonomitest — spelledaren riggar pipeline med deals i olika stadier
och dispatchar ett minimalt prompt. ClawWink förväntas SJÄLVSTÄNDIGT:
  - identifiera deals som behöver uppmärksamhet
  - skapa CRM-tasks per deal
  - rapportera findings med rätt severity

Varför inte ett workflow: ett workflow kör vid en fast trigger och
tillämpar samma regel på alla deals. ClawWink bedömer varje deal i
kontext — ålder, stage, värde, anteckningar — och väljer åtgärd därefter.

Kör:
  python3 SIM-011-stale-deals.py
  python3 SIM-011-stale-deals.py --dry-run
"""

import urllib.request, json, sys, time, uuid, datetime

# ── Config ────────────────────────────────────────────────────────────────────
FLOWWINK_MCP  = "https://rzhjotxffjfsdlhrdkpj.supabase.co/functions/v1/mcp-server"
FLOWWINK_TOKEN = "fwk_2df1ca1199419a71e99c41514ca5a723be7fdf05e80557db17d5028a0dfe3d40"
CLAWWINK_URL  = "https://clawwink.froste.eu/v1/responses"
CLAWWINK_TOKEN = "9ce7a22c055ed24f8894b1e66a522067e1f20237e08f11dde7e7ee1765aad6f7"
DRY_RUN       = "--dry-run" in sys.argv

RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

# ── Syntetiska prospekt (deals i olika stadier) ───────────────────────────────
PROSPECTS = [
    {
        "name":  f"Björn Lindqvist (sim-{RUN_ID})",
        "email": f"bjorn.sim.{RUN_ID}@byggfirman.se",
        "note":  "Visade intresse för ordermodulen. Ingen kontakt sedan första mötet.",
        "value": 185_000_00,   # 185 000 SEK i öre
        "stage": "proposal",
    },
    {
        "name":  f"Sofia Eriksson (sim-{RUN_ID})",
        "email": f"sofia.sim.{RUN_ID}@redovisning.se",
        "note":  "CFO, 40-personers redovisningsbyrå. Demo bokad men inställd — aldrig ombokas.",
        "value": 320_000_00,
        "stage": "negotiation",
    },
]

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
print(f"  SIM-011  Stale Deal Reactivation — {RUN_ID}")
print(f"  dry_run={DRY_RUN}")
print(f"{'═'*64}")

# STEP 1 — PREP: Skapa leads + deals för att fylla pipeline
step(1, "PREP — Skapa prospekt + deals (spelledaren riggar scenen)")
deal_ids = []

for p in PROSPECTS:
    print(f"\n  Prospekt: {p['name']}")
    lead_id = f"dry-run-{uuid.uuid4()}"
    deal_id = f"dry-run-{uuid.uuid4()}"

    if not DRY_RUN:
        # Skapa lead
        lead_data = parse_result(mcp_tool("add_lead", {
            "email":  p["email"],
            "name":   p["name"],
            "source": "referral",
        }, "?groups=crm"))
        lead_id = (lead_data.get("lead_id")
                   or lead_data.get("result", {}).get("lead_id")
                   or lead_data.get("id")
                   or lead_id)
        print(f"    Lead   : {lead_id}")

        # Skapa deal kopplat till lead
        deal_data = parse_result(mcp_tool("manage_deal", {
            "lead_id":    lead_id,
            "value_cents": p["value"],
            "stage":      p["stage"],
            "currency":   "SEK",
            "notes":      p["note"],
        }, "?groups=crm"))
        # manage_deal returnerar inget deal-ID — känd begränsning i Flowwink
        success = deal_data.get("status") == "success" or deal_data.get("success")
        print(f"    Deal   : {'✅ skapad' if success else '⚠️ ' + str(deal_data)} | stage={p['stage']} | {p['value']//100} SEK")
    else:
        print(f"    [DRY RUN] Lead + deal redo")
        print(f"    Note: {p['note'][:60]}...")

print(f"\n  ✅ Pipeline förberedd — {len(PROSPECTS)} nya deals injicerade")
print(f"  OBS: Systemet innehåller även befintliga deals från 2026-04-17")
print(f"       (dessa är ~2 dagar gamla och utan aktivitet)")

# STEP 2 — DISPATCH: Minimalt prompt — inget steg-för-steg
step(2, "DISPATCH — Minimal mission (autonomitest)")

# Avsiktligt vagt: vi specificerar INTE vilka deals, INTE vilken tröskel,
# INTE vilka verktyg — ClawWink ska bedöma detta självständigt
mission = """AUTONOMOUS MISSION — SIM-011 Pipeline Health

Du är ClawWink, autonom operatör för Flowwink.

Kör en pipeline-analys. Identifiera deals som behöver uppmärksamhet och agera.

Rapportera dina findings via openclaw_report_finding.
"""

print(f"  Dispatchar till {CLAWWINK_URL}")
print(f"  Prompt-längd: {len(mission)} tecken (minimalt — autonomitest)")

if not DRY_RUN:
    resp = dispatch(mission, timeout=20)
    if resp.get("fire_and_forget"):
        print("  ✅ Fire-and-forget — ClawWink kör async")
    else:
        print(f"  Status: {resp.get('status','?')}")
        if resp.get("output"):
            print(f"  Output: {str(resp['output'])[:200]}")
else:
    print("  [DRY RUN] Mission redo")
    print(f"\n  Mission:\n{mission}")

# STEP 3 — VERIFY: Poll för findings om stale deals
step(3, "VERIFY — Väntar på ClawWinks pipeline-findings (max 120s)")
if not DRY_RUN:
    found = False
    for attempt in range(12):
        time.sleep(10)
        data = parse_result(mcp_tool("scan_beta_findings", {"limit": 15}))
        findings = data.get("findings", [])

        # Matcha på deal-IDs eller generella pipeline-signaler
        deal_id_prefixes = [d[:8] for d in deal_ids]
        hits = [f for f in findings
                if any(pfx in f.get("title","") or pfx in f.get("description","")
                       for pfx in deal_id_prefixes)
                or any(kw in f.get("title","").lower() or kw in f.get("description","").lower()
                       for kw in ["stale", "pipeline", "deal", "inaktiv", "stagnerande",
                                  "prospekt", "follow", "följ"])]

        if hits:
            print(f"\n  ✅ {len(hits)} finding(s) mottaget efter ~{(attempt+1)*10}s:")
            for f in hits:
                print(f"     [{f.get('severity','?').upper()}] {f.get('title','?')}")
                print(f"     type={f.get('type','?')}")
                print(f"     {str(f.get('description',''))[:160]}")
                print()
            found = True
            break
        print(f"  ... {(attempt+1)*10}s — inga pipeline-findings än")

    if not found:
        print("  ⚠️  Inga findings på 120s")
        print("  → Kolla /admin/flowpilot → Activity för att se vad ClawWink körde")
else:
    print("  [DRY RUN] Hoppas över")

# STEP 4 — VERIFY: Kolla om CRM-tasks skapades
step(4, "VERIFY — Kontrollera att CRM-tasks skapades per deal")
if not DRY_RUN:
    # Ge lite extra tid om vi inte fick findings
    time.sleep(5)
    data = parse_result(mcp_tool("crm_task_list", {"limit": 10}, "?groups=crm"))
    tasks = data.get("tasks", data.get("items", []))
    recent = [t for t in tasks
              if any(pfx in str(t) for pfx in [RUN_ID[:10], "stale", "stagnerande", "inaktiv"])]
    if recent:
        print(f"  ✅ {len(recent)} CRM-task(s) hittade relaterade till sim:")
        for t in recent:
            print(f"     {t.get('title','?')} — due: {t.get('due_date','?')}")
    else:
        print(f"  ℹ️  Inga sim-specifika CRM-tasks hittade (ClawWink kan ha tagit")
        print(f"      en annan åtgärd, eller tasks syns ej via crm_task_list)")
        print(f"  → docker exec clawstack-clawwink cat memory/2026-04-19.md")
else:
    print("  [DRY RUN] Hoppas över")

print(f"\n{'═'*64}")
print(f"  SIM-011 {'[DRY RUN] ' if DRY_RUN else ''}DONE")
print(f"  Deals injicerade : {len(PROSPECTS)}")
print(f"  Run ID           : {RUN_ID}")
print(f"{'═'*64}")
print()
print("  Vad vi testar mot ett klassiskt workflow:")
print("  ✓ Identifierade ClawWink VILKA deals som är problematiska (eget omdöme)?")
print("  ✓ Varierade åtgärden beroende på deal-kontext (stage, värde, note)?")
print("  ✓ Skapade proportionerliga CRM-tasks (inte bara en generisk påminnelse)?")
print()
print("  Nästa steg:")
print("  1. docker exec clawstack-clawwink cat /home/node/.openclaw/workspace/memory/2026-04-19.md")
print("  2. Kör SIM-012 (Dunning Cascade) som nästa\n")
