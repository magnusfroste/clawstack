# SIM-018: Timesheet to Invoice — Konsultflödet

**Status:** 📝 Draft  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**OBJ:** OBJ-002 (Q2C), OBJ-005 (Financial compliance)  
**Skills:** `log_time`, `timesheet_summary`, `invoice_from_timesheets`, `manage_invoice`, `send_invoice_email`

---

## Hypotes

ClawWink kan autonomt hantera ett konsult-/tjänsteföretags faktureringsflöde: övervaka tidsloggning på projekt, avgöra när det är dags att fakturera, generera faktura från timmar och skicka den — med rätt timing och utan att fakturera för tidigt eller för sent.

**Varför detta är ett distinct sim från SIM-016:**  
SIM-016 startar med ett lead. SIM-018 startar med utfört arbete. Det är det klassiska konsultbolagets problem: "vi har gjort jobbet — nu ska vi se till att pengarna kommer in."

---

## Agent-vs-automation-argumentet

En statisk automation fakturerar på ett datumtrigger: "första dagen i månaden → kör invoice_from_timesheets." Den bryr sig inte om:

- Är projektet klart? (milstolpe nådd?)
- Är timmarna godkända av projektledaren?
- Har kunden fått sin rapport/leverans?
- Matchar fakturabeloppet kontraktet?
- Är kundrelationen i gott skick (inga öppna disputes)?

Agenten checkar alla dessa innan den fakturerar. Det är skillnaden mellan en process och ett omdöme.

---

## Spelledarens ansvar (PREP)

1. Skapa ett testprojekt i Flowwink (eller använd befintligt): "Konsultprojekt Alpha"
2. Logga 3–5 timmar mot projektet via `log_time` (spelledaren gör detta via MCP)
3. Koppla projektet mot ett befintligt lead/deal (Erik Magnusson från SIM-016 om körd)
4. Alternativt: använd befintliga projekt/timmar om de finns i live-data

---

## Dispatch-mission (till ClawWink)

```
AUTONOMOUS MISSION — SIM-018 Timesheet to Invoice

Din uppgift är att hantera faktureringsflödet för ett konsultprojekt:

1. Läs flowwink://briefing
2. manage_projects action=list — identifiera aktiva projekt med loggade timmar
3. timesheet_summary — hämta obetalda/oinvoicerade timmar per projekt
4. För varje projekt med oinvoicerade timmar:
   a. Bedöm om det är rätt att fakturera nu:
      - Finns det ett kontrakt kopplat? (manage_contract list)
      - Matchar timmarna kontraktets scope?
      - Är det rimligt att fakturera nu (timing, milstolpar)?
   b. Om ja: invoice_from_timesheets — generera faktura
   c. Om nej: rapportera varför du väntar (finding av typ suggestion)
5. För genererade fakturor:
   a. manage_invoice action=send — skicka faktura med betalningslänk
   b. openclaw_report_finding — typ positive, "invoice generated from timesheets"
6. Summera: hur många projekt fakturerades, vilka väntade och varför

Rapportera MISSION_COMPLETE med:
- Antal projekt granskade
- Antal fakturor genererade + total summa
- Antal projekt där du INTE fakturerade och varför
```

---

## Assertions (VERIFY)

| Assert | Pass-kriterie |
|--------|---------------|
| `timesheet_summary` kör | Returnerar data eller tomt set |
| `invoice_from_timesheets` kör | invoice_id returneras |
| Agenten resonerar om timing | MISSION_COMPLETE innehåller motivering |
| Minst 1 conditional | Agenten väljer att INTE fakturera ett projekt (om möjligt) |
| Invoice skickad | `manage_invoice send` eller `send_invoice_email` körd |
| Findings rapporterade | minst 1 finding |

---

## Det intressanta scenariot

Om agenten hittar timmar på ett projekt utan kontrakt → ska den fakturera? Nej — men en automation hade gjort det. Agenten flaggar `missing_data` (inget kontrakt) och väntar.

Det är det häpnadsväckande momentet: agenten skyddar affären genom att *inte* agera när förutsättningarna inte stämmer.

---

## Koppling till Fas 2 (multi-agent)

I Fas 2 är det **Levi (leverantörsagenten)** som loggar tid och **ClawWink** som fakturerar. SIM-018 är grunden för det flödet — vi testar att timesheet→invoice fungerar innan vi lägger på A2A-kommunikation.

---

## Förväntade gap-findings

- `log_time` kanske kräver ett user_id som inte finns i agent-kontexten → `bug`
- `invoice_from_timesheets` kanske inte är exponerad som MCP-skill → `missing_feature`
- Kontrakt-kopplingen till projekt kanske saknas i datamodellen → `missing_data`

---

## Handbook-output

Kapitelmaterial för: *"Konsultflödet — från utfört arbete till betalning"*  
Bevis: Agenten fakturerar inte för tidigt. Det är ett beslut, inte ett datumtrigger.
