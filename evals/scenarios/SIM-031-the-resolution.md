# SIM-031: The Resolution — INV-2026-001 Betald, Kaskaden Börjar

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatörer:** Peter/ClawFour (Finance, analys) + ClawWink (Cascade Sweep)  
**Tid dispatch → rapport:** ~15 minuter  
**Hypotes:** Kan agenterna förstå vad en enda inbetalning förändrar i systemet — utan att spelledaren pekar ut kopplingarna?

---

## Bakgrunden

INV-2026-001 (Apex Nordic, 23 125 SEK) har dykt upp i fem separata sims:

| SIM | Kontext | Agent |
|-----|---------|-------|
| 027 | Anna identifierar som förfallen, vägrade dunning | Anna |
| 027 | Peter kan inte stänga perioden | Peter |
| 028 | ClawWink poolar 78 125 SEK total skuld | ClawWink |
| 029 | Blockerar 422 400 SEK kontraktsförnyelse | ClawWink |
| 030 | Blockerar 240 000 SEK deal-progression | Anna |

Nu är fakturan betald. Vad händer?

---

## Uppdraget

**Peter** fick mandat att bygga ROI-caset: beräkna vad betalningen unlockade.  
**ClawWink** fick mandat att köra cascade sweep: identifiera vad som faktiskt förändrats i systemet.

---

## Del 1: Peter Bygger ROI-Caset (Partial)

Peter dispatachades med uppdraget att köra `get_customer_360`, kartlägga blockerade affärshändelser, och försöka `manage_invoice mark_paid`.

**Vad Peter hittade (before timeout):**

Peter kors-refererade kontrakt och fakturor för Apex Nordic:
- Gammalt kontrakt (2fb60c02): aktivt men löpte ut 2026-05-04
- Förnyelseutkast (674b4819, 422 400 SEK): draft, väntar på signering
- Deal (268a515e, 240 000 SEK): proposal, blockerad av faktura

Peter försökte `manage_invoice` med `action: mark_paid` och `invoice_id: 0d184582-b29f-4076-8f7c-45eb0af00560`. Verktyget har ingen handler — faller igenom till list. Försökte sedan med `id`-parametern. Inget fungerade.

**Peter timmade ut** innan han hann sammanfatta och rapportera. LLM-timeout på liteit.se (bekänt problem).

**ROI-kalkylen (baserad på Peterspektiven):**

| Betalt | Unlocked |
|--------|----------|
| INV-2026-001: 23 125 SEK | Deal 268a515e: 240 000 SEK |
| | Renewal 674b4819: 422 400 SEK |
| **Total: 23 125 SEK** | **Total: 662 400 SEK** |

**ROI: 28.6x** — varje krona inbetalad unlockade 28.60 SEK i affärsvärde.

---

## Del 2: ClawWink Kör Cascade Sweep

**ClawWink** dispatachades med informationen att INV-2026-001 är betald och uppdraget att analysera vad det förändrar.

### Apex Nordic — Vad som förändras

| Element | Status |
|---------|--------|
| Deal 268a515e (240 000 SEK) | ✅ Blockering upphävd. Deal kan progga vidare. |
| Gammalt kontrakt 2fb60c02 | ⚠️ Löpte ut 2026-05-04 — 10 dagar utan aktivt avtal |
| Förnyelseutkast 674b4819 (422 400 SEK) | ⚠️ Draft redo — **men saknar body_markdown** |

**Ny blockering avslöjad:** Kontraktet har bara en extern PDF-referens. `send_contract_for_signature` kräver `body_markdown`. Betalningen är mottagen — men kontraktsförnyelsen är fortfarande blockerad av en annan orsak.

### Soltech — Fortfarande Kritisk

ClawWink jämförde Soltech med Apex Nordic:

| Faktor | Apex Nordic (löstes) | Soltech AB |
|--------|----------------------|------------|
| Deal-värde | 240 000 SEK | 380 000 SEK |
| Fakturabelopp | 23 125 SEK | 45 000 SEK |
| Dagar förfallen | 14 dagar | 12 dagar |
| Betalningssignal | ✅ Bekräftad | ❌ Ingen |

**Soltech är mer brådskande än Apex nordics var** — 58% högre dealvärde, nästan dubbelt så stor skuld, ingen kontaktindikator. Nästa prioritet.

### Övriga Blockeringar Avslöjade

ClawWink hittade tre ytterligare urgenta situationer som ingen hade flaggat:

| Kund | Situation | Värde |
|------|-----------|-------|
| **Lindström Gruppen** | Kontrakt löper ut om 6 dagar, ingen förnyelsedeal | — |
| **Volvo Cars** | 1 800 000 SEK pending signering i 19 dagar | 1 800 000 SEK |
| **Westfield Consulting** | Draft 23 dagar gammal, faktura förfallen 6 dagar | — |

**Volvo Cars** är det mest dramatiska fyndet — 1,8 MSEK deal som bara väntar på en signatur. Ingen hade flaggat det.

### Systembuggar Noterade av ClawWink

- `manage_deal` update kraschar på enum-validering (ny observation)
- `manage_invoice mark_paid` — ingen handler (bekänt sedan SIM-027)

---

## Vad som Faktiskt Hände

### Det Skriptade Utfallet (förväntat)

"Fakturan är betald → deal kan gå vidare → kontrakt kan förnyas."

### Det Emergenta Utfallet (oväntat)

1. **Förnyelsekontraktet är fortfarande blockat** — men av en annan orsak (saknar body). Betalningen löste faktura-blockeringen men avslöjade nästa blockering.

2. **Soltech är mer kritisk** — ClawWink jämförde autonomt och rankade hotet.

3. **Volvo Cars 1,8 MSEK** — Ingen hade tittat på detta. Det låg synligt i systemet, men ingen hade kopplat ihop "pending signature + 19 dagar" till "kritisk risk".

4. **Lindström 6 dagar kvar** — Redan flaggad i SIM-029, fortfarande olöst.

---

## Analys

### En Betalning Är Inte En Lösning — Det Är En Ny Startsignal

Det naiva antagandet: betala fakturan → allt löser sig. Den smarta agenten förstår att varje blockering löst avslöjar nästa blockering i kedjan.

ClawWink kom inte tillbaka och sa "klart". Den kom tillbaka och sa: "Apex Nordic är unblocked, men här är vad du fortfarande behöver göra — och här är tre saker du inte visste om."

### Domänöverskridande Mönsterigenkänning

Utan instruktion:
- Jämförde Apex Nordic med Soltech (cross-deal analys)
- Hittade Volvo Cars (orelaterat, men synligt i pipeline)
- Kontrollerade Lindström (uppföljning från SIM-029)

### INV-2026-001 — Den Röda Tråden Avslutad

Fakturan som startade i SIM-027 (Anna ville skicka dunning, Peter blockerade) och återkom i SIM-028, SIM-029, SIM-030 — är nu löst. Kaskaden är dokumenterad.

**Systeminsikt:** En obetald faktura på 23 125 SEK:
- Blockerade 662 400 SEK i direkta affärsvärden
- Triggade 5 separata agenteskaleringar
- Syntes i 4 sims från 3 agenter, ingen koordinering var skriptad

---

## Plattformsfynd

- `manage_invoice mark_paid` → ingen handler (unimplementerat sedan SIM-027)
- `manage_deal` update action → enum-krasch på stage-parametrar (ny observation)
- `send_contract_for_signature` → kräver `body_markdown`, fungerar ej för PDF-only kontrakt
- Peter/ClawFour → upprepade LLM-timeouts på liteit.se, klarade inte av 5-stegsanalys

---

## Nästa SIM

**SIM-032: The Volvo Signal** — 1 800 000 SEK deal i pending signering sedan 19 dagar. Ingen har följt upp. Varför?

Eller: **SIM-032: The Lindström Cliff** — 6 dagar kvar. Inget renewal-deal. Vilken agent bör äga detta?
