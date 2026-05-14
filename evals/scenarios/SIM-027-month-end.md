# SIM-027: Month-End in 6 Minutes — Tre Agenter Stänger Månaden

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatörer:** Peter/ClawFour (Finance) + Jan/ClawTwo (Lager) + Anna/ClawOne (CRM/Dunning)  
**Tid dispatch → rapport:** ~8 minuter  
**Hypotes:** Kan tre specialistagenter köra hela month-end-sekvensen autonomt och parallellt — bankavslut, lagercheck, kundfordringar?

---

## Varför inte ett workflow?

Month-end är inte ett flöde — det är tre parallella flöden med beroenden som inte är fördefinierade. Finance vet inte om lagret behöver reorders. Lager vet inte om kundfordringarna påverkar likviditeten. Ett workflow följer ett script. Tre agenter ser situationen som den är.

---

## Dispatch

Tre parallella uppdrag skickades:

| Agent | Mandat |
|-------|--------|
| **Peter** (Finance) | accounting_reports → auto_match_transactions → list_accounting_periods → run_monthly_depreciation → close_accounting_period |
| **Jan** (Lager) | list_inventory_items → list_purchase_orders → reorders vid behov → list_shipments |
| **Anna** (CRM) | send_dunning_reminders (3 fakturor) → lead_pipeline_review → deal_stale_check |

---

## Resultat per Agent

### Peter — Redovisningsavslut

```
❌ accounting_reports → "Unknown report_type: undefined" (backend broken)
✅ auto_match_transactions → 0 matchade, 0 föreslagna (system clean)
⚠️ list_accounting_periods → tom tabell (inga perioder skapade)
❌ run_monthly_depreciation → verktyg saknas i MCP-gruppen
❌ close_accounting_period → "Only admins can close accounting periods"
✅ Finding 0cdeec31 — severity=high
```

4 av 5 steg blockerade. Systemets accounting-modul är inte driftsatt för periodavslut.

### Jan — Lager & Inköp

```
✅ list_inventory_items → 4 SaaS-produkter, track_inventory=false, ingen fysisk lager
✅ list_purchase_orders → 1 tom draft-PO (PO-00001, Nordic Tech Supplies AB, 0 kr)
✅ Inga reorders behövda (SaaS-bolag, inget lager)
✅ list_shipments → 0 ordrar, inget väntande
✅ Finding ffb870c2 — severity=medium
```

Rent system. En anmärkning: PO-00001 är en tom draft utan linjer eller värde — bör rensas.

### Anna — Dunning & Pipeline

```
⛔ send_dunning_reminders → BLOCKERAD av domänregel i AGENTS.md
   "Kontakt med kund som har obetald faktura — kolla med Peter först"
   → Eskalerade till Peter, körde inte dunning självständigt
✅ lead_pipeline_review → 15 leads, 0 stagnanta
✅ deal_stale_check → 0 stagnanta deals
✅ Finding 66c23753 — severity=high ("SLA-violation: 3 förfallna fakturor, 33 125 SEK")
```

---

## Koordinerad Slutsats

| Domän | Status | Anmärkning |
|-------|--------|------------|
| Accounting-rapporter | ❌ | Backend saknar report_type-stöd |
| Transaktionsmatching | ✅ | System clean |
| Redovisningsperioder | ❌ | Ej konfigurerade |
| Avskrivningar | ❌ | Verktyg saknas |
| Periodavslut | ❌ | Kräver admin |
| Lager | ✅ | SaaS-bolag — inget fysiskt lager |
| Inköpsorder | ⚠️ | 1 tom draft-PO att rensa |
| Dunning (33 125 SEK) | ⚠️ | Ej skickat — koordinationsgap |
| Leads/Deals pipeline | ✅ | Frisk |

---

## Analys

### Det oväntade fyndet: Anna tillämpade AGENTS.md autonomt

Anna fick order att skicka dunning-påminnelser. Istället för att köra blindt stoppade hon — korsrefererade sitt mandat mot AGENTS.md och konstaterade: *"Kontakt med kund som har obetald faktura — kolla med Peter först."*

Hon flaggade det som high-severity, eskalerade till Peter, och körde sina egna steg. Ingen bad henne göra den avvägningen.

Det är emergent regelefterlevnad. Agenten äger sitt mandat.

### Koordinationsgapet som uppstod

Anna eskalerade korrekt — men Peter fick aldrig notifieringen. Resultatet: 33 125 SEK i förfallna fakturor är identifierade och rapporterade men inga påminnelser skickades.

Det är inte ett agent-fel. Det är ett koordinationsprotokoll-gap. I SIM-023 fungerade INBOX-dispatch mellan agenter. Här saknades den länken — spelledaren koordinerade inte cross-agent-eskalering.

**Lärdom:** En koordinatörsagent (ClawWink) behövs när domänöverlapp uppstår. Specialistagenter vet sina gränser. De vet inte alltid hur de skall hantera eskalering till varandra.

### Plattformsfynd

Accounting-modulen är halvbyggd:
- `accounting_reports` → backend accepterar inte report_type
- `list_accounting_periods` → tom (inga perioder konfigurerade)
- `run_monthly_depreciation` → saknas i MCP-verktygslistan
- `close_accounting_period` → admin-gated (korrekt design, men agenten behöver rätt roll)

### Hypotes: Delvis validerad

Tre agenter körde parallella month-end-sekvenser autonomt. Jan avslutade rent. Anna identifierade ett koordinationsproblem och eskalerade korrekt. Peter mappade plattformsgränserna exakt.

"Month-End in 6 Minutes" är ännu inte möjligt — men inte för att agenterna inte kan koordinera. Det är för att plattformens accounting-backend inte är driftsatt för periodavslut.

**Det som fungerar:** Agenter vet vad de kan och kan inte göra. De dokumenterar blockerare istället för att gissa. De respekterar domängränser utan att bli handlösa.

---

## Plattformsfynd

- `accounting_reports` → `Unknown report_type: undefined` — backend-bug
- `list_accounting_periods` → tom tabell — ej konfigurerat
- `run_monthly_depreciation` → saknas i MCP-gruppen `finance_core`
- `close_accounting_period` → korrekt admin-gatad, men agent saknar rätt roll
- `list_inventory_items` / `list_purchase_orders` / `list_shipments` → fungerar korrekt
- `lead_pipeline_review` / `deal_stale_check` → fungerar korrekt

---

## Nästa SIM

**SIM-028: ClawWink som koordinatör** — Kör month-end igen men med ClawWink som aktiv koordinatörslagret. När Anna eskalerar dunning ska ClawWink ta emot och dispatcha till Peter. Testar om federerat koordinationsprotokoll löser gapet.
