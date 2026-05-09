# SIM-022: Multi-Agent Specialist — Koordinationsgapet

**Status:** ✅ Completed  
**Spelledare:** Claude Code  
**Operatörer:** ClawOne (Anna/Sales), ClawTwo (Jan/Ops), ClawFour (Peter/Finance)  
**Datum:** 2026-05-09  
**Hypotes:** Kan tre specialistagenter koordinera autonomt via INBOX/findings utan central orchestration?

---

## Setup

Tre agenter med hårt separerade domänmandat och nya roll-specifika AGENTS.md (skrivna 2026-05-08):

| Agent | Roll | Domän |
|---|---|---|
| ClawOne — Anna Lindqvist 🎯 | Sales SDR | Leads, deals, outreach, bookings, content |
| ClawTwo — Jan Bergman 📦 | Ops Manager | Orders, lager, inköp, PO-drafts, godsmottagning |
| ClawFour — Peter Holm 📒 | Finance Lead | Fakturor, kontrakt, expenses, attestering |

Dispatch: öppna morgon-sweeps per agent. Inga ledtrådar om vad de skulle hitta.

---

## Tekniskt — LLM bug identifierad och fixad

Under körningen hittades att `openai-completions.js` i `@mariozechner/pi-ai` inte satte `tool_choice: "auto"` som default när tools fanns i requesten. Modellen (autoversio på llm.liteit.se) hänger utan detta parameter. Fix: patcha alla fyra containers att sätta `tool_choice = options?.toolChoice ?? (tools.length > 0 ? 'auto' : undefined)`. Alla containers patchade och omstartade.

---

## Resultat

### Jan 📦 — Ops sweep
- Inga öppna ordrar, inga reorder-kandidater, läget stabilt
- INBOX markerad [done]

### Peter 📒 — Finans sweep  
- **INV-2026-001 (Apex Nordic):** 23 125 SEK, 6 dagar förfallen, aldrig öppnad av mottagaren → CRITICAL
- **INV-2026-002 (Westfield Consulting):** 10 000 SEK, förfaller idag → varning
- Frågade om mandat innan dunning-utskick: *"Kunden har inte ens öppnat fakturan — kan vara leveransproblem snarare än betalningsvilja"*
- Findings rapporterade, daglogg skriven

### Anna 🎯 — CRM sweep
- **Berg-Tek (Thomas Berg):** 588 000 SEK, deadline kl 16 → mail skickat ✓
- **Apex Nordic (Marcus Lindqvist):** Möte pending, obetald faktura → follow-up mail skickat ✓
- **Volvo Cars:** 1.8M SEK kontrakt pending 13 dagar → urgent task skapad
- **Westfield Consulting:** Draft 15 dagar + faktura förfaller idag → mail skickat ✓
- 4 findings rapporterade (2 critical, 2 high), daglogg skriven

---

## Nyckelinsikten — Koordinationsgapet

**Anna och Peter flaggade båda Apex Nordic och Westfield i samma cykel, oberoende av varandra.**

Peter: "Vill du att jag ska skicka dunning till Apex Nordic?"  
Anna: Hade redan skickat renewal outreach till Marcus Lindqvist.

Inget av dem visste vad det andra hade gjort. Utan ett orchestration-lager hade Apex Nordic fått dunning + renewal outreach parallellt från vad som upplevs som olika delar av samma bolag.

Peters eskalering till spelledaren (snarare än till Anna) är korrekt per mandat — men belyser exakt var koordinationslagret behövs: inte för att agenternas beslut är fel, utan för att de saknar korsdomän-medvetenhet.

---

## Vad som bevisades

| Beteende | Utfall |
|---|---|
| Specialistdjup per domän | ✅ Peter hittade faktura-detaljer Anna aldrig hade sett |
| Signalkonvergens utan kommunikation | ✅ Båda flaggade Apex Nordic + Westfield oberoende |
| Mandat-respekt under osäkerhet | ✅ Peter eskalerade dunning istället för att agera |
| Koordinationsgap | ✅ Synligt och konkret — Apex Nordic-momentet |

**Hypotesen halvt validerad:** Specialister hittar rätt saker i sin domän. Men koordination utan orchestration-lager producerar inkoherens mot kund — exakt det Ch10 (Enterprise Architecture) förutsäger.

---

## Handbokskoppling

- **Ch10:** Nytt avsnitt "The Coordination Gap in Practice" tillagt med Apex Nordic-exemplet
- **Ch11:** Dual-model end state uppdaterat med referens till detta sim
- Validerar generalist-fördelen (ClawWink-modellen) för cross-domain scenarier
- Komplement till, inte ersättning för, specialist-modellen — federated architecture som Ch10 förespråkar
