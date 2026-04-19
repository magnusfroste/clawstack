# Sim Plan — ClawWink Autonomy Track

> **Syfte:** Varje sim testar en konkret tidstjuv som ClawWink ska automatisera bort.  
> Spelledaren (Claude Code) riggar scenen realistiskt — ClawWink agerar autonomt utan detaljerade instruktioner.  
> Metodik: PREP → WAIT (heartbeat) → VERIFY → PERSIST

Senast uppdaterad: 2026-04-19

---

## Designprincip — Agent vs. Automation

> **Bär denna hatt hela tiden när du designar och läser sims.**

En vanlig invändning: *"Det här kan man ju göra med ett satt workflow eller RPA — vad tillför agenten?"*

Varje sim ska explicit svara på den frågan. En autonom agent motiveras när scenariot kräver minst ett av följande:

| Kräver | Varför ett workflow inte räcker |
|--------|--------------------------------|
| **Omdöme under osäkerhet** | Regler kan inte förutse alla kombinationer av data — agenten resonerar i kontexten |
| **Korskoppling av moduler** | Agenten kombinerar leads + deals + fakturor + tasks i ett resonemang, inte i separata triggers |
| **Undantagshantering** | Ett workflow kör eller kraschar — agenten väljer att eskalera, vänta eller byta strategi |
| **Adaptivt beteende** | Agenten uppdaterar AGENTS.md och beter sig annorlunda nästa gång baserat på utfall |
| **Proportionerlig åtgärd** | Svaret beror på kontext (score, kundhistorik, timing) — inte på en hårdkodad regel |

Varje sim nedan innehåller ett avsnitt **"Varför inte ett workflow?"** som besvarar detta konkret.

---

## Prioriteringslogik

Hög effektnytta × låg komplexitet först. Modulberoenden och nya Flowwink-features sist.

| Effekt | Komplex | Kategori |
|--------|---------|----------|
| Hög | Låg | 🔴 Kör nu |
| Hög | Medel | 🟡 Planera |
| Strategisk | Hög | 🔵 Kräver ny modul |

---

## 🔴 SIM-011 — Stale Deal Reactivation

**Fil:** `SIM-011-stale-deals.py`  
**Process:** Lead-to-Customer  
**Tidstjuv:** Deals fastnar i pipeline utan aktivitet — säljare ser det inte förrän det är för sent.

**Scen spelledaren riggar:**
- Skapa 2–3 deals som inte rörts på >7 dagar (via `manage_deal` med backdaterat `updated_at`)
- Trigga ClawWinks heartbeat

**ClawWink förväntas autonomt:**
1. Köra `deal_stale_check`
2. Identifiera stagnerande deals
3. Skapa `crm_task` per deal ("Följ upp — deal stagnant X dagar")
4. Rapportera finding med severity `medium`

**Verify:** Finding innehåller deal-ID, CRM-tasks skapade  
**Flowwink-verktyg:** `deal_stale_check`, `crm_task_create`, `openclaw_report_finding`  
**Nya moduler:** Inga  
**Branschdata:** HubSpot — 40% kortare säljcykler med stale-detection

**Varför inte ett workflow?**  
Ett workflow triggar på en fast regel: "om deal > 7 dagar → skicka notis". Agenten bedömer *varför* dealen stannat — är det en stor affär som väntar på budget? Är kontakten på semester? Är nästa steg oklärt? Åtgärden anpassas efter kontext, inte bara tid.

---

## 🔴 SIM-012 — Dunning Cascade (Förfallna fakturor)

**Fil:** `SIM-012-dunning-cascade.py`  
**Process:** Quote-to-Cash  
**Tidstjuv:** Förfallna fakturor hanteras ad hoc — ingen konsekvent upptrappning, DSO ökar.

**Scen spelledaren riggar:**
- Skapa fakturor med 3, 14 och 30 dagars förfall (via `manage_invoices`)
- Sätt status `sent` / `overdue`

**ClawWink förväntas autonomt:**
1. Köra `invoice_overdue_check`
2. Matcha förfallsdag mot upptrappningströsklarna:
   - dag 3 → vänlig påminnelse (newsletter/email)
   - dag 14 → eskalation (finding `high`)
   - dag 30 → finding `critical` + föreslå stop-order
3. Dokumentera varje åtgärd som finding

**Verify:** Findings per faktura med rätt severity-nivå, åtgärder dokumenterade  
**Flowwink-verktyg:** `invoice_overdue_check`, `manage_invoices`, `openclaw_report_finding`  
**Nya moduler:** Dunning-modul (upptrappningsregler, stop-order-logik) — **måste byggas**  
**Branschdata:** DSO minskar 30–50% med autonom dunning

**Varför inte ett workflow?**  
En dunning-automation skickar påminnelser enligt ett fast schema — oavsett vem kunden är. Agenten vet att faktura INV-042 tillhör Acme Corp (strategisk partner), väljer att inte skicka automail på dag 3, och flaggar istället för manuell kontakt. En nystartad kund på dag 30 hanteras hårdare. Omdömet är affärskritiskt — regler räcker inte.

---

## 🔴 SIM-013 — Support Ticket Auto-Triage

**Fil:** `SIM-013-ticket-triage.py`  
**Process:** Support-to-Resolution  
**Tidstjuv:** Öppna tickets utan ägare eller prioritet samlas — svarstider försämras, SLA bryts.

**Scen spelledaren riggar:**
- Skapa 3–5 tickets med varierande innehåll (fakturafråga, teknisk bugg, onboarding)
- Lämna dem oassignerade, prio = none

**ClawWink förväntas autonomt:**
1. Köra `ticket_triage` på oassignerade tickets
2. Sätta prioritet baserat på innehåll (faktura = high, onboarding = medium)
3. Assignera eller flagga för handoff
4. Föreslå KB-artikel per ticket där relevant
5. Rapportera finding om SLA-risk

**Verify:** Tickets har prio + ägare, finding rapporterat för SLA-risk  
**Flowwink-verktyg:** `ticket_triage`, `support_assign_conversation`, `manage_kb_article`  
**Nya moduler:** Inga  
**Branschdata:** 60–70% av L1-ärenden kan auto-triageras

**Varför inte ett workflow?**  
Keyword-routing ("om 'faktura' → hög prio") missar nyanser: "Jag är nöjd med er faktura" är inte ett brådskande ärende. Agenten förstår meningskontexten, kryssar mot kundens historia och väljer rätt prioritet + agent. Dessutom: om KB-artikeln saknas skapar agenten ett utkast — ett workflow kan bara routa, inte producera.

---

## 🟡 SIM-014 — Reorder Watcher (Lagerbevakning)

**Fil:** `SIM-014-reorder-watch.py`  
**Process:** Procure-to-Pay  
**Tidstjuv:** Lageruttömning upptäcks för sent — manuell bevakning, produkter tar slut utan förvarning.

**Scen spelledaren riggar:**
- Sätt 2–3 produkter under reorder-nivå via `manage_inventory`
- En produkt precis på gränsen (edge case)

**ClawWink förväntas autonomt:**
1. Köra `purchase_reorder_check`
2. Identifiera produkter under reorder-punkt
3. Skapa `purchase_order` mot rätt vendor
4. Flagga edge case som `low`-finding
5. Bekräfta PO med finding `info`

**Verify:** PO skapade för rätt produkter, edge case flaggat  
**Flowwink-verktyg:** `purchase_reorder_check`, `create_purchase_order`, `manage_vendor`  
**Nya moduler:** Inga

**Varför inte ett workflow?**  
En reorder-regel beställer när lagret underskrider X — alltid samma kvantitet, alltid samma vendor. Agenten ser att lead-time för en vendor är lång just nu, jämför mot order-pipeline och justerar kvantiteten. Edge cases (produkt avvecklas, säsongsvariationer) hanteras med omdöme, inte regeluppdateringar.

---

## 🟡 SIM-015 — 3-Way Match (Leverantörsfaktura)

**Fil:** `SIM-015-three-way-match.py`  
**Process:** Procure-to-Pay  
**Tidstjuv:** PO → goods receipt → vendor invoice matchas manuellt — avvikelser missas, felaktiga fakturor betalas.

**Scen spelledaren riggar:**
- Skapa PO, goods receipt och vendor invoice
- En invoice med avvikande belopp (±10%) för att trigga flaggning

**ClawWink förväntas autonomt:**
1. Hämta PO + GR + invoice
2. Jämföra belopp och kvantiteter
3. Godkänn-finding om match (`info`)
4. Avvikelse-finding med `high` + stoppa betalning

**Verify:** Avvikelse korrekt flaggad, inga felaktiga fakturor godkända  
**Flowwink-verktyg:** Kräver ny MCP-tool `match_purchase_invoice`  
**Nya moduler:** 3-way match tool i Flowwink — **måste byggas**

**Varför inte ett workflow?**  
En klassisk 3-way match-automation godkänner eller nekar binärt på beloppsavvikelse. Agenten bedömer: är ±3% en förhandlad rabatt eller ett fel? Är detta en ny vendor med historik av oegentligheter? Ska fakturan parkeras för manuell granskning eller nekas direkt? Kontextuell bedömning är hela poängen med kontrollmiljöer.

---

## 🔵 SIM-016 — Period-End Close (Bokslut)

**Fil:** `SIM-016-period-close.py`  
**Process:** Record-to-Report  
**Tidstjuv:** Periodavslut är en manuell checklista som tar dagar — obalans i konton hittas för sent.

**Scen spelledaren riggar:**
- Skapa transaktioner med avsiktlig obalans (ett konto felaktigt)
- Sätt datum = sista dagen i perioden

**ClawWink förväntas autonomt:**
1. Köra `accounting_reports` (BS + P&L)
2. Detektera obalans
3. Föreslå justeringsjournal
4. Rapportera finding `critical` med specificerad avvikelse
5. (Om balans OK) Föreslå periodlås

**Verify:** Obalans detekterad och korrekt rapporterad  
**Flowwink-verktyg:** `accounting_reports`, `manage_journal_entry` + ny `period_close_workflow`  
**Nya moduler:** Period-end close workflow — **måste byggas**

**Varför inte ett workflow?**  
Period-close är per definition ett undantagsflöde fullt av manuella beslut: vilka poster ska periodiseras? Är denna obalans ett datafel eller en legitim post? Ska perioden låsas trots att en leverantörsfaktura fortfarande saknas? Det är exakt det en erfaren controller gör — och det en agent kan replikera. Inget workflow i världen kan ta det beslutet.

---

## Status

| Sim | Namn | Status | Moduler saknas |
|-----|------|--------|----------------|
| SIM-010 | Lead-to-Customer | ✅ Klar (fix: lead_id parsing) | — |
| SIM-011 | Stale Deal Reactivation | 📝 Planerad | — |
| SIM-012 | Dunning Cascade | 📝 Planerad | Dunning-modul |
| SIM-013 | Support Ticket Auto-Triage | 📝 Planerad | — |
| SIM-014 | Reorder Watcher | 📝 Planerad | — |
| SIM-015 | 3-Way Match | 📝 Planerad | `match_purchase_invoice` |
| SIM-016 | Period-End Close | 📝 Planerad | `period_close_workflow` |
