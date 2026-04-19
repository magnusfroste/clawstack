# Fas 1 Spelplan — ClawWink som Flowwink-operatör

**Syfte:** Verifiera att Flowwink har alla MCP-ytor som behövs för B2B-processerna, och lära oss OpenClaw som system inför Fas 2 (multi-agent B2B).

**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**Period:** 2026-04-19 →  

---

## Spelledarens modell (per SIM)

```
1. PREP   — Claude Code injicerar testdata via MCP
2. DISPATCH — Claude Code skickar mission till ClawWink /v1/responses
3. VERIFY — Claude Code verifierar findings + workspace-uppdatering
4. PERSIST — ClawWink skriver in lärdomen i AGENTS.md / HEARTBEAT.md
```

Det är steg 4 som skiljer Fas 1 från tidigare sims — varje sim ska lämna ett bestående spår i ClawWinks workspace.

---

## Process → SIM-mappning

| SIM | Process | Maturity idag | Fokus | Nya verktyg |
|-----|---------|---------------|-------|-------------|
| SIM-010 | Lead-to-Customer | L4 | Full lead lifecycle: skapa → kvalificera → deal | `qualify_lead`, `manage_deal`, `lead_pipeline_review` |
| SIM-011 | Quote-to-Cash | L3 | Offert → signering → faktura | `manage_quote` (ny!) |
| SIM-012 | Content-to-Conversion | L4 | Kalender → brief → bloggpost | `content_calendar_view`, `seo_content_brief` |
| SIM-013 | Order-to-Delivery | L3 | Stale order → SLA-eskalering → fulfillment | `manage_orders`, `confirm_fulfillment` |
| SIM-014 | Procure-to-Pay | L3 | Lågt lager → PO → varuinleverans | `record_goods_receipt`, `update_purchase_order` |
| SIM-015 | Record-to-Report | L2 | Veckodigest → cross-modul-insikt | `weekly_business_digest` (ny!) |

---

## SIM-010: Lead-to-Customer — Full Lifecycle

**Hypothesis:** ClawWink kan självständigt ta ett nytt lead hela vägen från webbformulär till kvalificerat deal — utan mänsklig inblandning.

**Inject:** En ny lead "Anna Larsson" (simulerad besökare, kommer i Fas 2 att vara en riktig claw)
**Dispatch:** ClawWink qualificerar, skapar deal, lägger CRM-task
**Assert:**
- `qualify_lead` returnerar score > 0
- `manage_deal` skapar deal i stage `prospecting`
- `crm_task_create` skapar uppföljning inom 48h
- `openclaw_report_finding` rapporterar vad som gjordes

**Persist-uppdrag:** ClawWink skriver in "lead intake → qualify → deal" som ett recurring heartbeat-steg i AGENTS.md

---

## SIM-011: Quote-to-Cash — Offert → Signering → Faktura

**Hypothesis:** ClawWink kan hantera hela Q2C-loopen inklusive den nya quote-modulen.

**Inject:** Ett won deal utan offert (orealistiskt i produktion — men testar gapet)
**Dispatch:** ClawWink skapar offert, skickar, kontrollerar status
**Assert:**
- `manage_quote` skapar offert utan fel
- Offert kopplas till deal-ID
- Finding rapporteras om quote-status
**Gap-test:** Finns `send_quote_email` som MCP-tool? Om inte → finding av typen `missing_feature`

---

## SIM-012: Content-to-Conversion — Pipeline-audit

**Hypothesis:** ClawWink kan köra hela content-pipeline från audit till publicering baserat på live-data.

**Inject:** Ingen — använder befintligt blogg- och analytics-data
**Dispatch:** ClawWink kör `content_calendar_view` → identifierar gap → `generate_content_proposal` → `write_blog_post`
**Assert:**
- `content_calendar_view` returnerar data (nytt verktyg — vet vi inte om det fungerar)
- Bloggpost skapas med korrekt `created_by`
- SEO-brief genereras via `seo_content_brief`

---

## SIM-013: Order-to-Delivery — SLA-eskalering

**Hypothesis:** ClawWink identifierar och eskalerar en stale order autonomt.

**Inject:** Order `e2c09094` är redan 7+ dagar pending (live data)
**Dispatch:** ClawWink kör full order audit → flaggar SLA → försöker `confirm_fulfillment`
**Assert:**
- `sla_violation` finding med severity `high`
- `confirm_fulfillment` testas (vet vi om det kräver manuell input?)
- Gap-finding om saknad `returns`-hantering

---

## SIM-014: Procure-to-Pay — Inköpscykel

**Hypothesis:** ClawWink kan hantera inköp-till-leverans med de nya PO-verktygen.

**Inject:** Produkt med lågt lagersaldo (eller skapa ett test-PO)
**Dispatch:** ClawWink kör `purchase_reorder_check` → skapar PO → `record_goods_receipt`
**Assert:**
- `record_goods_receipt` fungerar (nytt verktyg)
- `update_purchase_order` fungerar
- Lagersaldo uppdateras

---

## SIM-015: Record-to-Report — Veckodigest

**Hypothesis:** ClawWink kan syntetisera ett COO-summary från cross-modul-data.

**Inject:** Ingen — ren read-only audit
**Dispatch:** ClawWink kör `weekly_business_digest` + `inventory_report` + `accounting_reports` → skriver COO-sammanfattning
**Assert:**
- `weekly_business_digest` returnerar data (nytt verktyg — okänt om det fungerar)
- Finding av typen `positive` med digest
- ClawWink skriver sammanfattningen i sin `MEMORY.md`

---

## Vad vi lär oss om OpenClaw (handbook-input)

Varje SIM dokumenterar:
1. **Dispatch-mönstret** — hur man ger ett effektivt uppdrag (struktur, kontext, assertions)
2. **Persistens-mönstret** — hur man får ClawWink att skriva in beteenden i workspace-filer
3. **Gap-mönstret** — hur man identifierar saknade MCP-ytor innan Fas 2
4. **Findings-mönstret** — hur findings fungerar som kommunikationskanal

Dessa fyra mönster är kärnan i handbook-kapitlet: *"Hur man sätter upp en effektiv claw som orkestrator/operatör till ett annat SaaS"*

---

## Ordning

Kör i denna ordning — varje SIM ska vara godkänd innan nästa:

```
SIM-010 → SIM-013 → SIM-012 → SIM-011 → SIM-014 → SIM-015
```

(010 och 013 använder befintlig live-data och är minst beroende av inject.)
