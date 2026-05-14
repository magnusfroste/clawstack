# SIM-028: Koordinationsbryggan — Kan ClawWink Se Gapet Anna Lämnade?

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatörer:** ClawWink (COO-koordinatör) + Peter/ClawFour (Finance)  
**Hypotes:** Kan ClawWink autonomt identifiera ett koordinationsgap från SIM-027 — att Anna eskalerade dunning men Peter aldrig fick notisen — och bridga det?

---

## Bakgrund

I SIM-027 tillämpade Anna AGENTS.md korrekt: hon vägrade skicka dunning-påminnelser utan att "kolla med Peter först." Hon skapade en finding (66c23753, severity=high) och eskalerade. Men Peter fick aldrig notisen. 33 125 SEK i förfallna fakturor låg obesvarade.

SIM-028 ger ClawWink uppdraget: se gapet, fyll det.

---

## Vad ClawWink Hittade

ClawWink körde `list_invoices` och bekräftade:

| Faktura | Kund | Belopp | Förfall | Status |
|---------|------|--------|---------|--------|
| INV-2026-010 | Soltech AB | **45 000 SEK** | 2026-05-02 | sent, obetald |
| INV-2026-002 | Westfield Consulting | 10 000 SEK | 2026-05-08 | sent, obetald |
| INV-2026-001 | Apex Nordic | 23 125 SEK | 2026-04-30 | sent, obetald |

**Totalt: 78 125 SEK** — Anna hade rapporterat 33 125 SEK. Soltech ABs faktura på 45 000 SEK saknades i hennes rapport. ClawWink hittade den.

---

## De Tre Blockerarna

ClawWink försökte bridga gapet på tre sätt — alla blockerade:

| Försök | Resultat | Anledning |
|--------|----------|-----------|
| Kör `send_dunning_reminders` direkt | ❌ Admin-gated | "Only admins can send dunning reminders" |
| Skriv till `/opt/clawstack/instances/clawfour/workspace/INBOX.md` | ❌ Permission blocked | Containers har inte filesystem-access till varandra |
| Kör via exec | ❌ Permission blocked | Samma sandboxgräns |

---

## Operatören Bridgade

Eftersom inter-agent messaging inte finns som native funktion i plattformen fick spelledaren manuellt skriva Peters INBOX. Peter fick uppdraget via COO-koordinatörens namn.

Peters körning:
```
→ send_dunning_reminders (alla tre)
→ HTTP 202 — approve-gated
→ "Kräver admin/approver-rättigheter"
→ Verifierade fakturastatus, skapade finding
```

Dunning är också approve-gated — korrekt compliance-design. Ingen agent kan massa-kontakta kunder utan mänskligt godkännande.

---

## Analys

### Det ClawWink Gjorde Rätt

Hittade 45 000 SEK som Anna hade missat. Det var inte instruerat — ClawWink körde en fullständig `list_invoices` istället för att förlita sig på Annas rapport. Oberoende verifiering.

### Plattformsfyndet

Inter-agent messaging saknas som native infrastruktur. Agenter kan inte skriva till varandras INBOX via filesystem (sandboxat), och det finns inget meddelandeprotokoll för agent-till-agent-kommunikation.

Tre olika blockeringsmekanismer skyddar korrekt:
1. Funktionsbehörighet (dunning = admin-gated)
2. Filesystem-isolation (containers delar inte disk)
3. Exec-sandboxning (kan inte köra kommandon i andras kontexter)

Det är inte ett fel — det är korrekt design. Men det innebär att koordination idag kräver en mänsklig operator som brygga.

### Hypotes: Delvis validerad

ClawWink identifierade gapet och hittade mer pengar än den ursprungliga eskalationen visade. Men bridgningen kräver fortfarande mänsklig hand.

**Det som saknas:** Ett native INBOX-API som låter en agent dispatcha ett uppdrag till en annan agent via plattformen — utan att dela filesystem.

---

## Plattformsfynd

- `send_dunning_reminders` → HTTP 202, approve-gated (korrekt)
- Inter-agent filesystem access → sandboxat (korrekt)
- Native inter-agent messaging → saknas (gap)
- `list_invoices` → funkar korrekt, returnerar fullständig data

---

## Nästa

**SIM-029-idé:** Designa ett native dispatch-protokoll — ClawWink skriver ett JSON-meddelande till en portal-endpoint som levererar det till rätt agents INBOX. Testa om plattformen kan stödja det utan filesystem-access.

Alternativt: **"The Contract Cliff"** — tre kontrakt löper ut nästa månad. Ingen har flaggat det. Kan ClawWink hitta dem, värdera förnyelse-risken och förbereda renewal-erbjudanden?
