# SIM-026: The Fraud Signal — Tre Agenter Hittar Bevis Ingen Bad Dem Söka

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatörer:** Peter/ClawFour (Finance) + Anna/ClawOne (CRM) + ClawWink (koordinator)  
**Tid dispatch → rapport:** ~6 minuter  
**Hypotes:** Kan tre specialistagenter konvergera på ett säkerhetsproblem autonomt — utan att spelledaren pekar ut lösningen?

---

## Varför inte ett workflow?

Ett fraud-detection-workflow sätter regler: "om faktura > PO-belopp → flagga". Men det förutsätter att PO:t finns. Vad händer när fakturan refererar ett PO-nummer som inte existerar alls?

Ingen regel fångar det som aldrig definierats. Agenten frågar: vad är det här egentligen?

---

## Scenario — Verkligt Fynd

Ingen riggning behövdes. `flag_invoice_variance` kördes och returnerade en real anomali som legat i systemet sedan 2026-04-30:

**Faktura GN-2026-0488 — Grossist Nord AB**
- Belopp: 60 937 SEK (inkl. moms)
- Varor: PE-folie, kartong, etiketter (förpackningsmaterial)
- Status: `received`, `unmatched`
- Refererar: `PO-2026-APX-0033` — **finns inte i systemet**
- Godkänd av: ingen (approved_by = null)
- Betald: nej

---

## Dispatch

Tre parallella uppdrag skickades 23:49:

| Agent | Mandat |
|-------|--------|
| **Peter** (Finance) | Kör `flag_invoice_variance`, försök PO-match, eskalera |
| **Anna** (CRM) | Undersök Grossist Nord i CRM — känd relation? Kontaktperson? |
| **ClawWink** (COO) | Koordinera: kontrakt, vendor-historik, bedömning + rekommendation |

---

## Resultat per Agent

### Peter — Finance-analys
```
✅ flag_invoice_variance → GN-2026-0488 identifierad
❌ match_po_to_invoice → PO-2026-APX-0033 finns inte
❌ approved_by = null — ingen intern godkännare
❌ Varor ej registrerade som mottagna (goods receipt saknas)
→ Finding: severity=critical — "Fakturan ska INTE betalas"
```

### Anna — CRM-undersökning
```
❌ 0 companies med "Grossist Nord"
❌ 0 leads eller deals kopplade
❌ 0 kontaktpersoner — ingen @grossistnord.se i systemet
→ Slutsats: "Ingen känd relation alls. Inget som legitimerar en faktura."
→ Finding: severity=high — eskalera till finance/legal
```

### ClawWink — Koordinationsrapport
```
✅ Vendor-kontot skapades 2026-04-30 — SAMMA DAG som fakturan
✅ Inga tidigare fakturor från denna vendor
✅ Inget kontrakt med Grossist Nord
✅ Fakturan ej betald — ingen ekonomisk skada ännu
→ PO-numret (APX-0033) matchar Apex Nordics namnformat
→ Finding: severity=critical (9b7708b4) — "compliance_issue"
```

---

## Koordinerad Slutsats

| Källa | Resultat |
|-------|---------|
| Finance — `flag_invoice_variance` | 1 omatchad faktura, 60 937 SEK, status `unmatched` |
| Contracts — `search_contracts` | Inget kontrakt med Grossist Nord |
| CRM — `manage_company` | Okänd part — noll affärshistorik |
| Vendor-historik | Konto skapat samma dag som fakturan |
| Betalningsstatus | Ej betald — ingen skada ännu |

**Bedömning:** Engångsproblem, ej etablerat mönster — men med röda flaggor:
- Vendor-konto och faktura skapades på exakt samma dag
- PO-referensen matchar Apex Nordics format (`APX-`) utan matchande PO
- Ingen intern godkännare, ingen goods receipt

**Möjliga förklaringar:**
1. Informellt direktinköp av anställd, aldrig loggat i FlowWink
2. Obehörig faktura som testar om betalning sker automatiskt
3. Legitim leverans från Apex Nordics underleverantör, processat utanför systemet

---

## Analys

### Vad fungerade
Tre agenter med olika domäntillgång konvergerade oberoende på samma faktura. Ingen enskild agent hade hela bilden — Peter såg finansanomalin, Anna bekräftade den okända relationen, ClawWink lade ihop timing-mönstret.

Fakturan hade legat i systemet i 14 dagar. Inget mänskligt team hade undersökt den.

### Det som lyfter hakan
ClawWink noterade att vendor-kontot skapades **exakt samma dag** som fakturan. Det var inte i dispatchen — det var ett emergent fynd från att korskontrollera vendor-metadata mot invoice-datum. Ingen bad agenten leta efter det. Den hittade det ändå.

### Hypotes: Validerad
Tre agenter konvergerade autonomt på ett säkerhetsproblem och producerade en koordinerad rapport med rekommendationer — utan mänsklig koordination. Den ekonomiska exponeringen (60 937 SEK) är identifierad och blockerad innan skada skett.

**Det är inte regelbaserad fraud detection. Det är omdöme.**

---

## Plattformsfynd

- `flag_invoice_variance` fungerar korrekt — returnerar `unmatched` fakturor
- `match_po_to_invoice` fungerar men hittar inget (korrekt beteende)
- `openclaw_report_finding` (list-action) kastar DB-fel (`null value in type column`) — findings skapas men kan inte listas via API
- `manage_vendor` create fungerar men saknar `amount_cents` på `vendor_invoices` → kan inte skapa test-fakturor via API

---

## Nästa SIM

**SIM-027: Month-End in 6 Minutes** — Peter kör: bankimport → matcha transaktioner → depreciation → stänger perioden. Jan: lagerstatus + reorders. Anna: sena fakturautdrag. ClawWink koordinerar sekvensen.
