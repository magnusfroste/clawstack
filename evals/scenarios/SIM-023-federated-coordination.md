# SIM-023: Federated Coordination — ClawWink som orchestration-lager

**Status:** 📝 Planerad  
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

## Nästa steg efter design

1. Verifiera att ClawWink har filesystem-access till specialist-workspaces i container
2. Planta data i FlowWink
3. Kör specialist-sweeps (morgon)
4. Kör ClawWink coordination-sweep (eftermiddag)
5. Dokumentera utfall
