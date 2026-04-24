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

*Fylls i efter körning*

**Antal fynd:** TBD  
**A1 Westfield hittad:** TBD  
**A2 Bergman hittad:** TBD  
**A3 TechHub hittad:** TBD  
**A4 Apex hittad:** TBD  
**Total SEK i riskzon:** TBD / 1 225 000 SEK möjligt

---

## Varför detta bevisar autonomin

En RPA-lösning hade behövt fyra separata regler, skrivna av en människa som *redan visste* vad anomalierna var. ClawWink fick en öppen fråga och en tom databas att läsa. Om den hittar kopplingen deal→kontrakt för Westfield, eller kontrakt-slutdatum→tom pipeline för Apex — är det agentens eget resonemang, inte en instruktion i ett manus.

Det är skillnaden mellan ett verktyg och ett omdöme.
