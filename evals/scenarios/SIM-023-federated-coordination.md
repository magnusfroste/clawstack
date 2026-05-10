# SIM-023: Federated Coordination — ClawWink som orchestration-lager

**Status:** ✅ Genomförd (2026-05-10)  
**Spelledare:** Claude Code  
**Operatörer:** ClawWink (koordinator) + ClawOne/ClawTwo/ClawFour (specialister)  
**Hypotes:** Kan ClawWink läsa specialist-findings, identifiera cross-domain konflikter, och dispatcha koordination till rätt agent — utan att spelledaren ingriper?

---

## Varför inte ett workflow?

Ett workflow kan sätta regler: "om dunning + aktiv deal → blockera dunning". Men det kräver att du förutser exakt vilken kombination som kan uppstå. ClawWink resonerar: vilken kund är detta, vad pågår i relationen, vad är rätt sekvens av åtgärder? Det är omdöme, inte regelkörning.

---

## Scenario Setup (spelledaren riggar)

### Planterade datapunkter i FlowWink

**Kund A — Bergström & Partners (ny)**
- Lead: inbound inquiry, score okänd
- Inga existerande affärer

**Kund B — Soltech AB (befintlig)**
- Aktiv deal i stage "negotiation" (Anna arbetar med)
- Faktura INV-2026-010: 45 000 SEK, förfallen 8 dagar
- Order SO-2026-088: under plockning, 3 dagar kvar

**Kund C — Lindström Gruppen (befintlig)**
- Kontrakt löper ut om 10 dagar, ingen förnyelsedeal i pipeline
- Ingen förfallen faktura

### Dispatch-sekvens

1. **Morgon:** Specialist-sweeps (Anna, Jan, Peter) dispatchar normalt
2. **Eftermiddag:** ClawWink kör coordination-sweep via HEARTBEAT

---

## Vad specialisterna förväntas hitta

**Anna (ClawOne):**
- Bergström & Partners → qualify + skapa deal om score ≥60
- Soltech AB deal i negotiation → statusuppdatering
- Lindström Gruppen → ingen deal på utgående kontrakt → skapar task

**Jan (ClawTwo):**
- SO-2026-088 (Soltech AB) → plockning pågår, ingen blocker
- Rapport: allt OK

**Peter (ClawFour):**
- INV-2026-010 (Soltech AB): 45 000 SEK, 8 dagar förfallen → vill skicka dunning
- Eskalerar: "Soltech har aktiv deal — bekräfta att jag kan skicka dunning"

---

## Vad ClawWink förväntas göra

1. Kör `scan_beta_findings` — ser Peters finding om Soltech-fakturan
2. Korskopplar: Soltech AB = aktiv deal (Annas domän) + förfallen faktura (Peters domän) + order under plockning (Jans domän)
3. **Koordinationsdispatch till Peter:** "Soltech är i aktiv förhandling med Anna. Håll dunning tills Anna bekräftat deal-status. Jag koordinerar."
4. **Koordinationsdispatch till Anna:** "Soltech har förfallen faktura (45k, 8 dagar). Inkludera betalningsplan i ditt nästa steg med kunden."
5. **Rapport till spelledaren:** Koordinationsåtgärd vidtagen, Lindström Gruppen flaggad för förnyelse

---

## Framgångskriterier

| Kriterium | Mål |
|---|---|
| ClawWink identifierar Soltech-konflikten | ✅ Via scan_beta_findings |
| Peter hålls tillbaka från dunning | ✅ Koordinationsnotering i Peters INBOX |
| Anna informeras om finansblocker | ✅ Koordinationsnotering i Annas INBOX |
| Ingen mänsklig inblandning krävs för koordination | ✅ Spelledaren observerar, ingriper inte |
| Lindström Gruppen flaggas proaktivt | ✅ Finding eller task skapad |

---

## Setup-kommandon (spelledaren)

```bash
# Verifiera att ClawWink kan läsa specialist-INBOX-filer
docker exec clawstack-clawwink ls /opt/clawstack/instances/clawone/workspace/
docker exec clawstack-clawwink ls /opt/clawstack/instances/clawfour/workspace/

# Dispatcha specialist-sweeps
# [INBOX till Anna, Jan, Peter — morgon-sweep]

# Dispatcha coordination-sweep till ClawWink
# [INBOX till ClawWink — "kör coordination-sweep, läs findings, koordinera"]
```

---

## Handbokskoppling

SIM-023 är det direkta beviset för Ch10:s "federated specialization":
- Specialist-djup: varje agent hittade rätt sak i sin domän
- Koordinationslager: ClawWink löste konflikten utan spelledarens ingripande
- Resultatet: Soltech fick en koherent upplevelse trots tre separata agents

Om simen lyckas: nytt avsnitt i Ch10 — "The Coordination Layer in Action".
Om ClawWink missar konflikten: värdefullt negativt bevis, justerar design.

---

## Utfall (2026-05-10)

### Vad som faktiskt hände

**Morgon-sweeps:**
- **Jan (ClawTwo):** ✅ Klar på <2 min. Inga ordrar (Soltech SO-2026-088 skapades som quote, inte sales order). Rapporterade "allt OK".
- **Anna (ClawOne):** ✅ Klar efter 2 försök (LLM endpoint timeout på första). Hittade Soltech AB deal i negotiation (3,8M SEK), kontrakt INV-2026-010-notis, Lindström Gruppen kontrakt löper ut 20 maj.
- **Peter (ClawFour):** ✅ Klar efter 2 försök. Hittade INV-2026-010 (45 000 SEK, 8 dagar förfallen). **Eskalerade korrekt:** "Dunning är approve-gated. Inom mandat — jag rapporterar och eskalerar."

**ClawWink coordination-sweep:**
- ClawWink körde sweepen 3 gånger (LLM endpoint instabilitet + INBOX-rättighetsproblem)
- Körning 1 (21:18 UTC): Identifierade Soltech-konflikten, byggde cross-domain matris. Write misslyckades (EACCES — INBOX ägdes av root).
- Körning 2 (efter restart): Timeout från ny session.
- Körning 3 (efter chown 1000:1000-fix): **Lyckades skriva till Anna och Peters INBOX.**

**Dispatched content (ClawWink → Anna):**
- Soltech AB: cross-domain flagga, säkerställ att deal-pipeline är synkad med kontraktstatus
- Lindström Gruppen: prioritera (noterades som ny lead, borde ha identifierats som befintlig kund)

**Dispatched content (ClawWink → Peter):**
- Soltech AB: verifiera att faktura är betald, inga nya åtaganden vid obetald skuld
- Lindström Gruppen: förbered standardkontrakt

### Framgångskriteria — utfall

| Kriterium | Mål | Faktiskt |
|---|---|---|
| ClawWink identifierar Soltech-konflikten | ✅ Via scan_beta_findings | ✅ Via invoice_overdue_check + manage_deal |
| Peter hålls tillbaka från dunning | ✅ Koordinationsnotering i Peters INBOX | ⚠️ Peter eskalerade SJÄLV korrekt (utan ClawWink) |
| Anna informeras om finansblocker | ✅ Koordinationsnotering i Annas INBOX | ✅ Nota dispatched, men generisk (ej specifik faktura) |
| Ingen mänsklig inblandning krävs för koordination | ✅ Spelledaren observerar, ingriper inte | ✅ Spelledaren fixade infrastruktur (INBOX-rättigheter) men ingrep inte i koordinationslogiken |
| Lindström Gruppen flaggas proaktivt | ✅ Finding eller task skapad | ⚠️ Identifierades men behandlades som ny lead, inte befintlig kund |

### Tekniska lärdomar

1. **INBOX-rättigheter:** Filer skapade av spelledaren (root) måste chown 1000:1000 för att ClawWink (node) ska kunna skriva. Permanentfix: skapa INBOX-filer med `docker exec <container> touch` istället för direkt på host.

2. **LLM-endpoint instabilitet:** llm.liteit.se gick ner under simkörningen. Failover till code.autoversio.ai fungerade. Konfigurera fallback i openclaw.json.

3. **tool_choice-patch:** Måste appliceras efter varje container-restart (in-container patch, försvinner vid recreate). TODO: lägg till i post-start-script.

4. **Koordinationskvalitet:** ClawWink analyserade korrekt men koordinationsmeddelanden var generiska. Orsak: upprepade timeouts tvingade fram ny session utan full kontextbild. Hypotesen om federated coordination **validerades** — ClawWink identifierade cross-domain mönster och dispatchar autonomt.

5. **Peter's autonomous escalation:** Peter följde sitt AGENTS.md-mandat och eskalerade dunning korrekt UTAN att ClawWink behövde ingripa. Det visar att specialist-mandaten fungerar som första försvarslinje.

### Handboksimplikation

SIM-023 bekräftar att **federated specialization** fungerar i praktiken:
- Specialister hittar rätt saker i sina domäner (specialist-djup)
- Koordinationslagret (ClawWink) identifierar cross-domain mönster
- Systemet koordinerar autonomt (med några infrastruktur-friktioner)

Att Peter redan eskalerade korrekt utan ClawWinks ingripande är ett oväntat positivt fynd: mandatdesignen fungerar som decentraliserat koordinationslager redan på specialist-nivå.

## Nästa steg efter design

1. Verifiera att ClawWink har filesystem-access till specialist-workspaces i container
2. Planta data i FlowWink
3. Kör specialist-sweeps (morgon)
4. Kör ClawWink coordination-sweep (eftermiddag)
5. Dokumentera utfall
