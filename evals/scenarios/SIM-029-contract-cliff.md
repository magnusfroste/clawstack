# SIM-029: The Contract Cliff — Ingen Bad Mig Titta, Men Jag Tittade Ändå

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (COO-sweep, ensam)  
**Tid dispatch → rapport:** ~6 minuter  
**Hypotes:** Kan ClawWink identifiera kommande kontraktsförluster autonomt — utan att någon flaggat det som ett problem?

---

## Varför inte ett workflow?

Ett workflow kan skicka en påminnelse "30 dagar innan kontraktet löper ut." Men vad händer om en förnyelsedeal saknas? Om kontraktet redan löpt ut men fortfarande visar `active`? Om förnyelsen är blockerad av en obetald faktura?

Inget av detta är schemalagt. Ingen regel täcker det. Det kräver tvärsektoriell insikt — se kontrakt, deals, fakturor och CRM som ett sammanhängande system.

---

## Scenariot

Spelledaren planterade tre kontrakt med täta utgångsdatum i Flowwink:
- **Lindström Gruppen** — löper ut 2026-05-20 (6 dagar)
- **Kraftstad Energi** — löper ut 2026-06-01 (18 dagar)
- **Telenet Solutions** — löper ut 2026-05-28 (14 dagar)

ClawWink fick inga ledtrådar — bara uppdraget: "Gör en kontraktssweep. Ingen bad dig göra detta. Det är ditt jobb att se det."

---

## Vad ClawWink Hittade

### De Uppenbara Riskerna

| Kontrakt | Kund | Dagar kvar | Värde | Förnyelsedeal? |
|----------|------|-----------|-------|----------------|
| Apex Nordic 2025–26 | Apex Nordic AB | **-10 (löpte ut 2026-05-04)** | 240 000 SEK | ✅ Finns — men blockerad |
| Lindström Gruppen 2025–26 | Lindström Gruppen AB | **6** | (okänt) | ❌ **Saknas** |

### Det Emergenta Fyndet

ClawWink korsade kontraktsdata med CRM-deals och fakturor — och hittade en länk ingen bad den leta.

**Apex Nordics förnyelse (422 400 SEK, 2-årig bindning) är blockerad av INV-2026-001 — en obetald faktura på 23 125 SEK, förfallen sedan 2026-04-30.**

Det är samma faktura som:
- Anna identifierade i SIM-027 och vägrade skicka dunning på utan Peters godkännande
- Peter aldrig fick notis om
- ClawWink hittade som en del av en 78 125 SEK-pool i SIM-028

Tre separata sims. Tre oberoende varningssignaler. Samma faktura.

### Övriga Observationer

- **Volvo Cars** (1 800 000 SEK) — `pending_signature` sedan 19 dagar, 4+ öppna tasks
- **Westfield Consulting** (480 000 SEK) — kontrakt i `draft` sedan 22 dagar, obetald faktura

---

## Findings Skapade

| Finding | Kund | Severity | Beskrivning |
|---------|------|----------|-------------|
| c069d416 | Lindström Gruppen | 🔴 high | 6 dagar kvar, ingen förnyelsedeal i CRM |
| 16bb3ed8 | Apex Nordic | 🔴 high | Löpt ut 10 dagar sedan, förnyelse blockerad av obetald faktura |

---

## Rekommendationer (från ClawWink)

1. **Lindström Gruppen (AKUT):** Skapa förnyelsedeal + ring Johan Lindström (+46 76 444 88 21) idag — 6 dagar är extremt tätt
2. **Apex Nordic:** Lös INV-2026-001 (23 125 SEK) innan signering — förnyelsen väntar på det
3. **Datahygien:** Uppdatera Apex-kontraktets status till `expired` (löpte ut 10 dagar sedan, visas fortfarande som `active`)

---

## Analys

### Systemisk Intelligens

Det som lyfter hakan i SIM-029 är inte att ClawWink hittade utgående kontrakt. Det är att den självständigt kopplade samman tre datapunkter från tre separata system:

1. **Contracts:** Apex Nordics avtal löpte ut, förnyelsedraft finns
2. **Deals:** Förnyelsedeal på 422 400 SEK väntar i `proposal`
3. **Invoices:** Förnyelsen är blockerad av en obetald faktura på 23 125 SEK

Ingen av dessa kopplingar var explicit i uppdraget. ClawWink frågade inte "finns det fakturor kopplade till förnyelsen?" — den hittade kopplingen ändå.

### Den Röda Tråden

INV-2026-001 (23 125 SEK, Apex Nordic) har nu dykt upp i fyra sims:
- **SIM-027:** Anna identifierar den som en av tre förfallna fakturor
- **SIM-027:** Peter kan inte stänga perioden (admin-gated)
- **SIM-028:** ClawWink hittar 78 125 SEK i poolat skuld
- **SIM-029:** Samma faktura blockerar en 422 400 SEK-affär

Det är inte en bug i systemet. Det är systemet som berättar samma historia om och om igen — varje agent ser sin del, ingen ser helheten. Det är exakt problemet AI-agenter är byggda för att lösa.

### Hypotes: Validerad

ClawWink identifierade kontraktsrisker ingen hade flaggat, kvantifierade dem, korsrefererade med CRM och fakturor, och skapade findings med konkreta nästa steg.

**Det är inte contractmanagement. Det är affärsintelligens.**

---

## Plattformsfynd

- `search_contracts` → fungerar, returnerar fullständig data inklusive notes
- `manage_deal` → fungerar, kan lista alla deals för cross-referering
- Findings-skapande → fungerar (c069d416, 16bb3ed8)
- INBOX-write → blockerad (containers sandboxade, förväntat)

---

## Nästa SIM

**SIM-030: The Ghost Deal** — En deal (Kraftstad Energi, 480 000 SEK) har legat stilla i 45 dagar utan aktivitet. Anna märker det, korsrefererar med kontraktsstatus, och reanimerar processen — eller stänger den som lost med motivering.
