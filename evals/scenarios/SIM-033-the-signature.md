# SIM-033: The Signature — En Funktion, 1 800 000 SEK, En Bug

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatör:** Peter/ClawFour (Finance)  
**Tid dispatch → rapport:** ~3 minuter  
**Hypotes:** Kan Peter skicka ett kontrakt för digital signering i en enda körning?

---

## Uppdraget

Anna bekräftade i SIM-032 att Volvo Cars-kontraktet (79ea47c9, 1 800 000 SEK) aldrig skickats via det digitala signeringsflödet — `sent_at: null`. Peter fick ett fokuserat uppdrag: kör `send_contract_for_signature`.

---

## Vad Peter Gjorde

Peter körde uppdraget i tre steg:

1. **Lockade kontraktet** med `acquire_lock` (bra praxis, vill ha exklusiv access)
2. **Körde `send_contract_for_signature`**:
   - contract_id: `79ea47c9-947a-4d6e-820c-fce3df21c3b4`
   - signer_email: `anders.olsson@volvocars.com`
   - signer_name: Anders Olsson
   - **Returnerade: `status: success`**
3. **Verifierade resultatet** — hämtade kontraktet igen för att bekräfta `sent_at` och `accept_token`

---

## Det Peter Hittade

Verktyget returnerade `success`. Men Peter verifierade direkt:

| Fält | Förväntat | Faktiskt |
|------|-----------|---------|
| `sent_at` | timestamp satt | **null** |
| `accept_token` | token genererad | **null** |
| `viewed_at` | — | **null** |
| `updated_at` | ny timestamp | 2026-04-27 (oförändrad) |

Peter noterade diskrepansen och dokumenterade den explicit:

> *"API:et returnerade success men läsvyn visar fortfarande accept_token: null och sent_at: null. Detta kan bero på att läsvyn returnerar cachelad data. Token har genererats server-side — men jag rekommenderar en manuell verifiering att Anders Olsson faktiskt fått länken om inget svar kommer inom 2–3 dagar."*

**Finding 6200aa6b rapporterad** (severity: high).

---

## Platform Bug Bekräftad

`send_contract_for_signature` returnerar `success` men sätter varken `sent_at`, `accept_token` eller `updated_at`. Kontraktet är oförändrat i databasen.

**Konsekvens:** Anders Olsson fick förmodligen aldrig signeringslänken. Den anropades nu av Anna (som inte hade verktyget) och av Peter (som körde det korrekt men utan effekt).

**Felkedjan:**
```
2026-04-25  → Notat: "Skickat för underskrift" (manuellt mail, ej via system)
2026-05-14  → Anna saknar manage_contract (SIM-032)  
2026-05-14  → Peter kör send_contract_for_signature → "success" → sent_at fortfarande null
```

Det verkar som att `send_contract_for_signature` antingen:
a) Returnerar false success (tool handler defekt), eller  
b) Skickar notifikationen externt men uppdaterar inte databasen (split-brain)

---

## Analys

### Agenten Kontrollerade Resultatet

Peter kallade inte uppdraget klart vid "success". Han hämtade kontraktet igen och jämförde mot förväntade fältvärden. Det är det korrekta beteendet vid kritiska write-operationer: **verifiera att skrivningen faktiskt tog effekt**.

En människa som sett "success" hade förmodligen stängt ärendet. Peter stannade kvar och frågade: stämmer databasen med svaret?

### "Success" Som Löfte Utan Garanti

Plattformens responskontrakt (`status: success`) är defekt: det lovar ett utfall utan att leverera det. Agenten absorberade felkontraktet korrekt — noterade skillnaden, flaggade det, rekommenderade manuell verifiering.

### Vad som fortfarande Saknas

1. `send_contract_for_signature` — handler defekt, rättar ej `sent_at/accept_token`
2. Anders Olsson har väntat 19+ dagar. Fortfarande ingen länk.
3. 1 800 000 SEK-kontraktet är fortfarande osignerat.

---

## Plattformsfynd

- `send_contract_for_signature` → returnerar success utan att uppdatera `sent_at`, `accept_token` eller `updated_at`
- Samma mönster som `manage_invoice mark_paid` (SIM-027) och `auto_mark_invoice_paid` (SIM-031): tools lovar åtgärd utan att leverera den
- **Mönster:** Finance-write-operationer returnerar "success" men är stubbar, ej implementerade end-to-end

---

## Nästa SIM

**SIM-034: The Lindström Deadline** — Kontrakt löper ut om 5 dagar (2026-05-19). Inget renewal deal. ClawWink eller Anna äger det?
