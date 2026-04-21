# SIM-017: Bank Reconciliation — Closing the Automation Ceiling

**Status:** 📝 Draft  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**OBJ:** OBJ-005 (Financial compliance)  
**Nytt sedan SIM-009:** `sync_stripe_payouts`, `auto_match_transactions`, `list_unmatched_transactions`, `import_bank_file`

---

## Hypotes

ClawWink kan köra bankavstämning autonomt — inklusive att *resonera om omatchade transaktioner* och fatta beslut om dem, vilket är det exakta steget där klassisk automation slutar och ett mänskligt omdöme normalt tar vid.

**Det här är "automationstakets" poster child:**  
Varje ekonomisystem matchar 80% av transaktioner automatiskt. De sista 20% — de omatchade — skickas till en redovisare. Agenten kan nu ta det steget.

---

## Agent-vs-automation-argumentet

| Fas | Automation | Agent |
|-----|------------|-------|
| Importera Stripe-utbetalningar | ✅ Kan automatiseras | ✅ |
| Matcha mot fakturor (1:1) | ✅ Kan automatiseras | ✅ |
| Hantera omatchade transaktioner | ❌ Flaggar — mänskligt beslut | ✅ Resonerar om varje post |
| Korskolla mot expenses, PO, contracts | ❌ Silad per modul | ✅ Ser tvärs moduler |
| Eskalera vs. auto-godkänna | ❌ Fast regel | ✅ Bedömer beloppet, historiken, kontexten |

Det omatchade är exakt det en agent tillför som ingen workflow kan: *"Denna transaktion på 12 500 SEK matchar inte mot en faktura — men korskollas mot inköpsorder PO-0023 och det stämmer. Auto-matching justerad."*

---

## Spelledarens ansvar (PREP)

1. Verifiera att `sync_stripe_payouts` är exponerad som MCP-tool (eller via skill)
2. Om möjligt: skapa 2–3 testinbetalningar i Stripe-testmiljö
3. Säkerställ att minst 1 inbetalning INTE matchar mot en befintlig faktura (omatchad) — detta är kärnan i sim:en
4. Alternativ om Stripe-test ej är möjligt: använd `import_bank_file` med en CSV-fil spelledaren konstruerar

---

## Dispatch-mission (till ClawWink)

```
AUTONOMOUS MISSION — SIM-017 Bank Reconciliation

Din uppgift är att köra en komplett bankavstämning:

1. Läs flowwink://briefing
2. sync_stripe_payouts — hämta senaste utbetalningar från Stripe
3. auto_match_transactions — kör automatisk matchning mot fakturor
4. list_unmatched_transactions — lista vad som inte matchade
5. För varje omatchad transaktion:
   a. Korskollas mot: manage_invoice (list), manage_expenses, create_purchase_order (list)
   b. Om match hittas: rapportera din slutledning och föreslå manuell matchning
   c. Om ingen match: rapportera som missing_data finding med detaljer
6. Summera: hur många matchades automatiskt, hur många manuellt (av dig), hur många kvarstår
7. openclaw_report_finding — en finding per omatchad transaktion du hanterat

Rapportera MISSION_COMPLETE med:
- Antal automatiskt matchade
- Antal du resonerade om och löste
- Antal kvarstående (kräver mänsklig input)
- Total reconcilieringsgrad i procent
```

---

## Assertions (VERIFY)

| Assert | Pass-kriterie |
|--------|---------------|
| `sync_stripe_payouts` kör utan fel | Returnerar transaktioner eller tomt set |
| `auto_match_transactions` kör | Returnerar match-statistik |
| `list_unmatched_transactions` kör | Returnerar lista (tom = OK, men vi vill ha omatchade) |
| Tvärmodulkorsning utförd | ClawWink kollar invoice + expenses + PO för omatchade |
| Finding per omatchad | minst 1 finding av typ `missing_data` eller `positive` |
| Reconcilieringsgrad rapporterad | Procent i MISSION_COMPLETE |

---

## Förväntade gap-findings

- `import_bank_file` kräver troligen en fil-upload — MCP-tool kanske inte stöder det → `missing_feature`
- `auto_match_transactions` kan saknas som exponerad MCP-skill trots att modulen finns
- Stripe-integration kanske inte är konfigurerad i testinstansen → `stale_entity`

---

## Handbook-output

Kapitelmaterial för: *"Automationstaket — de 20% som kräver omdöme"*  
Bevis: En agent som ser en omatchad transaktion och korskollsar mot inköpsorder, fakturor och expenses i ett svep är fundamentalt annorlunda än ett ekonomisystem som flaggar och väntar på en redovisare.

Citera SIM-017-resultatet direkt i `the-automation-ceiling.md`.
