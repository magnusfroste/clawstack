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

*Fylls i efter körning*

**Datum:** 2026-04-21  
**Total risk identifierad:** TBD SEK  
**Antal fynd:** TBD  
**Täckta dimensioner:** TBD/6  

### Fynd

*Listas efter körning*

---

## Lärdomar

*Fylls i efter analys*
