# SIM-019: Revenue Risk Sweep — Tvärmodulär intäktsrisk

**Status:** 🚀 Dispatched  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**OBJ:** OBJ-001 (Pipeline health), OBJ-002 (Q2C), OBJ-005 (Financial compliance)  
**Skills:** `list_deals`, `list_invoices`, `list_orders`, `list_contracts`, `manage_invoice`, `send_invoice_email`, `update_deal`, `list_leads`

---

## Hypotes

En autonom extern agent kan i ett svep identifiera samtliga intäktsrisker som korsar modulsgränser — saker som inga enskilda automationer ser eftersom de kräver korrelation mellan pipeline, ordrar, fakturor och kontrakt. ClawWink genomför sweepen, kvantifierar den totala risken i SEK och flaggar varje fynd med kategori och prioritet.

**Varför detta är ett distinct sim från SIM-016/018:**  
SIM-016 och SIM-018 följer ett givet flöde (lead → cash, timmar → faktura). SIM-019 söker aktivt efter _avvikelser_ utan ett startflöde — ett diagnostiskt sweep, inte ett processlödet. Det är skillnaden mellan att följa ett manus och att läsa av en patient.

---

## Agent-vs-automation-argumentet

En klassisk RPA-lösning kör separata jobb:
- "Fakturor äldre än 30 dagar → påminnelse"
- "Deals utan aktivitet 14 dagar → alert"
- "Ordrar ej leverade 7 dagar → ticket"

Problemen den _inte_ ser:
- En deal med hög sannolikhet men inget kontrakt (ordern kan inte bokas)
- En faktura betald men ingen deal stängd i CRM (pipeline är inflated)
- Tre separata deals mot samma kund men ingen konsoliderad faktura (kunden är irriterad)
- Ett kontrakt som löper ut om 14 dagar men ingen förnyelsedeal i pipeline

Agenten korrelerar alla fyra moduler i ett pass. Det är inte fyra automationer — det är ett resonemang.

---

## Scenariot

ClawWink startar utan given fråga. Den vet att dess uppdrag är att hålla FlowWinks intäktsmotor frisk. Den bestämmer själv vilka dimensioner som är relevanta att sweep:a, i vilken ordning, och vad som är rapporteringsvärt.

### Förväntade riskdimensioner att täcka

| Dimension | Signal | Risk |
|-----------|--------|------|
| Draft-kontrakt | Status = draft, age > 7d | Intäkt obekräftad |
| Förfallna fakturor | Due date passerat, status ≠ paid | Cash flow |
| Pipeline-duplikat | Samma kund, liknande belopp, båda "qualified" | Inflated pipeline |
| Ordrar utan faktura | Order delivered, no linked invoice | Revenue leak |
| Kontrakt nära utgång | Expiry < 30d, no renewal deal | Churn risk |
| Deal-stagnat | No activity > 14d, stage = "proposal" | Stale pipeline |

---

## Framgångskriterier

| Kriterium | Godkänt |
|-----------|---------|
| Täcker ≥ 4 riskdimensioner | Ja |
| Kvantifierar varje fynd i SEK | Ja |
| Anger riskprioritering (hög/medium/låg) | Ja |
| Skapar minst ett actionable finding | Ja |
| Förklarar varför varje fynd inte kan fångas av en enkel automation | Ja |

---

## Dispatched prompt

```
MISSION: Revenue Risk Sweep — SIM-019

You are ClawWink, the autonomous operator for FlowWink. Your mission is a comprehensive revenue risk sweep across all financial modules.

Methodology:
1. Read the live state of pipeline (deals), invoices, orders, and contracts
2. Identify cross-module anomalies that signal revenue risk
3. Quantify each finding in SEK where possible
4. Prioritize: HIGH (immediate action needed), MEDIUM (this week), LOW (monitor)
5. For each finding, explain why it cannot be caught by a single-module automation

Cover at minimum:
- Draft contracts older than 7 days (unbooked revenue risk)
- Overdue invoices (cash flow risk)
- Pipeline duplicates against the same customer (inflated pipeline)
- Delivered orders with no linked invoice (revenue leak)
- Contracts expiring within 30 days with no renewal deal in pipeline (churn risk)
- Deals with no activity for 14+ days in proposal stage (stale pipeline)

Report findings using openclaw_report_finding for each identified risk.
End with a summary: total SEK at risk (sum of all quantified findings), top 3 actions recommended.

Begin sweep now.
```

---

## Resultat

**Datum dispatched:** 2026-04-21
**Rekonstruerat från:** FlowWink `scan_beta_findings` (tabell `beta_findings`)
**Antal fynd:** 3 (alla `medium` severity)
**Täckta dimensioner:** 1 av 6 (endast draft-kontrakt)
**Total risk identifierad i SEK:** 0 (inga belopp sattes på fynden)

### Fynd

| Timestamp | Type | Title | ID |
|-----------|------|-------|----|
| 2026-04-21 10:57 | stale_entity | Draft contract present over 2 hours without progress (contract 'test') | `b30a8908-5e70-4f80-8348-5d8e3fc0106c` |
| 2026-04-21 14:56 | broken_chain | compliance-hygiene: Expense audit failed — system error (`invalid input syntax for type date`) | `72991c19-3f51-40c2-9bc7-1e14c76f4ebc` |
| 2026-04-21 19:26 | stale_entity | OBJ-003: Draft contract still pending signature (samma 'test'-kontrakt) | `61ed5ef7-7dc9-4361-9e3b-e2c9c919ff3c` |

### Status vs framgångskriterier

| Kriterium | Resultat |
|-----------|----------|
| Täcker ≥ 4 riskdimensioner | ❌ 1 dimension (draft-kontrakt) |
| Kvantifierar varje fynd i SEK | ❌ 0 SEK angivet |
| Anger riskprioritering | ⚠️ endast medium |
| Skapar minst ett actionable finding | ✅ 3 stycken |
| Förklarar varför varje fynd inte kan fångas av automation | ❌ nej |

---

## Lärdomar

**Instruktionsfällan.** Den dispatched prompten listade explicit sex dimensioner att sweep:a — men ClawWink återvände ändå en smal compliance-lista, inte en bred diagnostisk sweep. Två förklaringar:

1. **MCP-ytan saknade bredd vid körning.** Flera av de listade dimensionerna (delivered orders utan faktura, pipeline-duplikat via domän-matchning, kontrakt nära utgång) krävde tool-anrop som antingen var under-implementerade eller blockerade av trust-level `approve` den dagen.
2. **Prescriptive prompt → instruction-compliance, inte autonomi.** Detta är just argumentet SIM-020 designades för att motbevisa — att en öppen prompt producerar rikare diagnostik än en checklista. SIM-020:s resultat (18 findings inklusive cross-module Westfield) bekräftar det.

**Re-run-rekommendation.** MCP-ytan är bredare nu (137 tools, flera generiska CRUD-wrappers). En öppen-prompt SIM-019-körning idag skulle sannolikt ge betydligt starkare resultat. Kör om innan handboken går live om möjligt.

**Handbook-koppling.** Ch03 "Day One (SIM-019): The Unprompted Sweep — €1.1 million of risk" kan INTE beläggas från detta scenarios findings. Antingen:
- Reframe Ch03 Day One som en separat tidigare körning (utan SIM-numrering), eller
- Kör om SIM-019 med öppen prompt och uppdatera Resultat, eller
- Markera Ch03 Day One som `partial` evidens.
