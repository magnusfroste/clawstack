# SIM-032: The Volvo Signal — 1 800 000 SEK En Funktion Ifrån

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatör:** Anna/ClawOne (Sales/CRM), 2 körningar  
**Tid dispatch → rapport:** ~12 minuter (2 körningar)  
**Signal:** Emergent fynd från SIM-031 (ClawWink flaggade i cascade sweep)  
**Hypotes:** Kan Anna följa upp en kontraktssignal, identifiera varför den fastnat, och ta rätt åtgärd?

---

## Bakgrunden

I SIM-031:s cascade sweep hittade ClawWink ett kontrakt listat under "övriga blockeringar":

> **Volvo Cars** (1 800 000 SEK) — pending signering **19 dagar**

Ingen hade frågat ClawWink om detta. Det låg synligt i kontraktslistan. ClawWink läste det och förstod att 19 dagar utan signatur var en varningssignal.

Ingen agent ägde signalen. Nu fick Anna uppdraget.

---

## Vad Anna Hittade (Körning 1 — 40 CRM-verktyg)

Anna kartlade hela situationen autonomt:

### Lead-profil
**Anders Olsson** (`e13bd5f1`) — Engineering Productivity Manager, Volvo Cars Corporation
- Status: "lead" (ej kvalificerad som deal-kontakt)
- Score: 8, engagement: "cold"
- Skapad 2026-05-12 från "contract_pending"

### CRM-bristen
**Ingen deal för Volvo Cars** i pipeline. 16 deals i systemet — ingen för Volvo Cars. Ett kontrakt värt 1 800 000 SEK utan CRM-deal är en oupptäckt affär.

### Förfallen Task
En urgent task `07d57a93` hittad i CRM-historiken:
- **Titel:** "RING Anders Olsson om inget svar inom 24h"
- **Due:** 2026-05-13 kl 09:00
- **Status:** Ej avklarad — **2 dagar försenad**
- **Beskrivning:** Refererar kontrakt `79ea47c9`

Tasken sa att om inget svar kom skulle vi ringa. Inget svar kom. Ingen ringde.

### Annas Åtgärder

1. **Follow-up mail skickat** till anders.olsson@volvocars.com
2. **Förfallen task markerad** som avklarad
3. **Ny task skapad** för nästa eskaleringssteg  
4. **Deal skapad i CRM** — f285e8ab, 1 800 000 SEK, kopplad till lead e13bd5f1

Deal-notering (Annas egna ord):
> *"Deal skapad retroaktivt av Anna Lindqvist 2026-05-14. Kontrakt 79ea47c9 har funnits utan deal i pipeline — 1 800 000 SEK, pending signature sedan ~2026-04-25. Kontakt: Anders Olsson (Engineering Productivity Manager). Lead auto-länkad. Status: kontrakt väntar på kundens underskrift."*

---

## Det Anna Missade (Root Cause)

Kontraktet har följande systemfält:

| Fält | Värde |
|------|-------|
| `status` | `pending_signature` |
| `notes` | "Skickat för underskrift 2026-04-25" |
| `sent_at` | **null** |
| `viewed_at` | **null** |
| `accept_token` | **null** |

Notes påstår att kontraktet skickades 2026-04-25. Men `sent_at` är null. Det finns ingen `accept_token`. Anders Olsson har aldrig fått länken.

**Kontraktet har aldrig skickats via det digitala signeringsflödet.**

Noterna ljuger inte avsiktligt — de reflekterar förmodligen ett manuellt mail som skickades utanför systemet. Men den digitala signaturlänken skapades aldrig.

---

## Körning 2 — Fokuserad Kontroll

Anna dispatachades igen med ett fokuserat uppdrag: kontrollera `sent_at` och kör `send_contract_for_signature` om null.

**Resultat: Domenvägg**

Anna saknar `manage_contract` i sin CRM-verktygsyta. Av de 40 tools Anna normalt har åtkomst till, monterades bara 3 i sessionen:
- `acquire_lock`
- `report_finding`  
- `release_lock`

`send_contract_for_signature` är en kontrakt-operation — den faller inom Peters domän (Finance), inte Annas (Sales/CRM).

**Finding f705f027 rapporterad** av Anna:
> *"Blockerad: manage_contract och send_contract_for_signature finns inte bland tillgängliga MCP-verktyg. Kontraktet 79ea47c9 (1 800 000 SEK) kan inte skickas för signering från CRM-domänen. Spelledaren måste antingen montera kontraktsverktyg eller köra via Finance."*

---

## Det Fullständiga Mönstret

```
2026-04-25  → Kontrakt skickat manuellt (mail utanför systemet)
             → sent_at aldrig satt i FlowWink
             → Anders Olsson aldrig fick digital signeringslänk

2026-05-12  → Lead e13bd5f1 skapad ("contract_pending")
             → Task: "ring om inget svar inom 24h"

2026-05-13  → Task förfaller. Ingen ringer.

2026-05-14  → ClawWink hittar det som sidofynd i SIM-031
             → Anna dispatachas, hittar CRM-bristen, skapar deal, skickar mail
             → Missar root cause (sent_at=null)
             → Andra körning: hittar domenvägg, rapporterar finding
```

**19 dagar utan signatur.** Orsak: en funktion som aldrig anropades.

---

## Analys

### En Funktion Ifrån 1 800 000 SEK

```
send_contract_for_signature(
  contract_id: "79ea47c9",
  signer_email: "anders.olsson@volvocars.com",
  signer_name: "Anders Olsson"
)
```

Det är allt som saknades. Kontraktet har `body_markdown` (till skillnad från Apex Nordics). Systemet kan skicka det. Det har bara aldrig gjort det.

### Agentens Bidrag

Anna hittade rätt spår: ingen deal, förfallen task, kall engagement. Hon fyllde CRM-gapet och eskalerade korrekt när hon stötte på domenvägg.

Det hon inte kunde göra:
- Se `sent_at: null` (saknade manage_contract)
- Skicka kontraktet (fel domän)

### Domenvägg som Design

Finance äger kontraktsignering. Sales äger kundrelationen. Men ingen äger *gapet* — steget mellan "kontrakt draftat" och "kontrakt skickat". Det är ett processgap, inte ett systemgap.

### Det Emergenta Fyndet

Ingen visste om Volvo Cars 19 dagar in. ClawWink hittade det som ett sidobynd i en helt annan sweep. Det visar att:
- Agenter ser saker som mänskliga processer missar
- Breadth-first sweep > point-in-time manuell granskning

---

## Plattformsfynd

- `send_contract_for_signature` — inte i Anna/Sales CRM-verktygsyta (korrekt domänavgränsning, men skapar gap)
- `manage_contract` — tillgänglig för Peter/Finance men inte Anna/Sales
- CRM task "07d57a93" — förfallen 2 dagar, inte synlig i standard task-sweep
- Deal `f285e8ab` skapad av Anna med felaktigt `value_cents` (18M istället för 180M) — notes korrekta

---

## Nästa SIM

**SIM-033: The Signature** — Peter dispatachas med ett mandat: skicka Volvo Cars-kontraktet för signering. En funktion. 1 800 000 SEK.

Eller: **SIM-033: The Lindström Deadline** — 6 dagar kvar. Ingen renewal deal. Vem äger det?
