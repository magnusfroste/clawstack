# SIM-020: Business Health Check — Spelledarriggad scen

**Status:** 🚀 Dispatched  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**Datum:** 2026-04-22  
**OBJ:** OBJ-001, OBJ-002, OBJ-005

---

## Designfilosofi — lösningen på instruktionsfällan

Dilemmat med SIM-019 var att prompten listade exakt vad ClawWink skulle hitta. Det är RPA med extra steg — instruerat, inte autonomt.

SIM-020 löser detta genom att:
1. **Spelledaren riggar scenen** med naturliga affärshändelser, inte uppradade anomalier
2. **Dispatchpromten är öppen** — "ge oss en genomlysning" — ingen checklista
3. **Fynden bevisar autonomin**, inte prompten

Sanningsprovet: *kan ClawWink korrelera saker vi aldrig nämnde?*

---

## Planterade anomalier (spelledarens anteckningar — ej i prompt)

### A1 — Westfield Consulting [CROSS-MODULE, HIGH]
- **Deal:** `closed_won`, 480 000 SEK, stängd 2026-04-10
- **Kontrakt:** `draft`, skapat 2026-04-12, aldrig signerat
- **Anomalin:** Pipeline visar vunnen affär men intäkten kan inte bokas utan signerat kontrakt
- **Kräver:** Korrelation deal-stage + contract-status per lead/counterparty
- **Värde i riskzon:** 480 000 SEK

### A2 — Bergman & Partners [PIPELINE-DUPLIKAT, MEDIUM]
- **Deal A:** lead `9a7ea959`, qualified, 185 000 SEK, via Johansson
- **Deal B:** lead `d45cb6b5`, qualified, 185 000 SEK, via Lindström
- **Anomalin:** Samma bolag (@bergman-partners.se), två parallella deals av olika säljare — pipeline inflated
- **Kräver:** Gruppering på e-postdomän / bolagsnamn, se mönstret
- **Inflated pipeline:** 185 000 SEK

### A3 — TechHub Stockholm [STAGNERAD DEAL, MEDIUM]
- **Deal:** `proposal`, 320 000 SEK, notes anger "offert skickad 2026-04-03"
- **Anomalin:** 19 dagar utan aktivitet — kunden svarar inte
- **Kräver:** Reasoning kring notes-innehåll + evt. `deal_stale_check`
- **Risk:** Deal troligen förlorad om ingen action

### A4 — Apex Nordic [CONTRACT CHURN, HIGH]
- **Kontrakt:** `active`, 240 000 SEK/år, slutdatum `2026-05-04` (om 12 dagar)
- **Pipeline:** Inga deals mot Apex Nordic lead (`4b0213a5`)
- **Anomalin:** Befintlig kund (sedan 2022) vars årskontrakt löper ut — ingen förnyelsedeal i pipeline
- **Kräver:** Korrelation kontrakt-slutdatum + pipeline-sökning per kund
- **Risk:** 240 000 SEK/år försvinner utan action

---

## Dispatch-prompt (vad ClawWink faktiskt fick)

```
God morgon, ClawWink. Det är tisdag 22 april.

Ge oss en genomlysning av affärsläget — vad behöver uppmärksamhet 
den närmaste veckan? Börja med pipeline och kontrakt, men se gärna 
bredare om du hittar saker som hänger ihop.

Rapportera varje fynd via openclaw_report_finding.
```

---

## Framgångskriterier

| Kriterium | Godkänt om... |
|-----------|--------------|
| Hittar A1 (Westfield) | ClawWink kopplar ihop deal + kontrakt självständigt |
| Hittar A4 (Apex churn) | ClawWink flaggar kontrakt som löper ut utan renewal |
| Hittar A2 eller A3 | Minst ett av de enklare fynden identifieras |
| Kvantifierar i SEK | Minst ett fynd har ett belopp |
| Kräver inte fler instruktioner | Hela sweepen sker utan follow-up prompt |

**Toppbetyg:** Alla fyra anomalier identifierade, A1+A4 som cross-module reasoning.

---

## Resultat

**Datum dispatched:** 2026-04-22
**Rekonstruerat från:** FlowWink `scan_beta_findings` (tabell `beta_findings`), 18 findings skapade 2026-04-22
**Antal fynd:** 18 (hög+medium+låg blandat)

### Anomali-match mot planterade scener

| Planterat | Hittat? | Finding-ID | Notering |
|-----------|---------|------------|----------|
| **A1 Westfield** (draft-kontrakt + closed_won deal) | ✅ JA | `bba21815-540a-460e-8724-3e8f63a97837` (SE), `0a76fffd-802d-4803-b088-5f52c1da0d28` (EN), `c7a64a17-335f-459e-bf66-d631eab407a5` | Kontraktet flaggat som "sänt för signatur 2026-04-12, ingen påminnelse" — värde 480 000 SEK (48 000 000 öre) |
| **A2 Bergman & Partners** (pipeline-duplikat, två parallella qualified deals) | ⚠️ DELVIS | `b1e77fa4-af82-4832-8941-2eefd248fd90`, `965eaaaf-e4f9-4e30-a1d6-166309016463` | ClawWink noterade Erik och Malin Bergman som cold leads men kopplade dem INTE som duplicate pipeline — domän-matchningen uteblev |
| **A3 TechHub Stockholm** (stagnerad 19 dagar) | ✅ JA | `d2abc259-6d1d-4eae-ad5b-21cb50f4e69f`, `30352fef-ce56-4219-b3ba-a594036d37a4` | 320 000 SEK deal, offert 2026-04-03, "ingen återkoppling på 19 dagar" — exakt det scenariot beskrev |
| **A4 Apex Nordic** (churn, kontrakt löper ut 05-04) | ✅ JA | `4fe7004a-a806-4eaa-9cdd-e726dbd62ea3` | 240 000 SEK/år, slutdatum 2026-05-04, ingen förnyelsedeal — flaggat som churn-risk |

**Score:** 3 av 4 planterade anomalier fångade med cross-module reasoning. A2 (duplicate deals) missad — ClawWink såg kunder men inte duplikaten.

**Total SEK belagt i findings:** 480 000 + 240 000 + 320 000 = **1 040 000 SEK** av möjliga 1 225 000 SEK.

### Bonus-fynd (ej planterade)

ClawWink hittade dessutom 4 unqualified cold leads (Sofia Karlsson, Malin Bergman, Erik Bergman, Jonas Lindqvist) och en content-cadence-gap (ingen blogpost på 7 dagar). Dessa var inte en del av spelledarens rigg men är legitima operational findings.

---

## Varför detta bevisar autonomin

En RPA-lösning hade behövt fyra separata regler, skrivna av en människa som *redan visste* vad anomalierna var. ClawWink fick en öppen fråga och en tom databas att läsa. Om den hittar kopplingen deal→kontrakt för Westfield, eller kontrakt-slutdatum→tom pipeline för Apex — är det agentens eget resonemang, inte en instruktion i ett manus.

Det är skillnaden mellan ett verktyg och ett omdöme.
