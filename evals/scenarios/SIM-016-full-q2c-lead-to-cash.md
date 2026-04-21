# SIM-016: Full Q2C — Lead to Cash

**Status:** 📝 Draft  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**OBJ:** OBJ-002 (Q2C), OBJ-003 (Lead management)  
**Nytt sedan SIM-011:** `manage_quote` (e-sign), `send_invoice_email` (PDF + Stripe-länk), `create-invoice-payment` (Stripe Checkout)

---

## Hypotes

ClawWink kan ta ett nytt lead hela vägen till betalat cash — autonomt, utan mänsklig inblandning:

```
lead (ny) → qualify → deal → quote (line items) → approval gate → 
e-sign länk → convert_to_invoice → send_invoice_email → 
Stripe Checkout → webhook → paid
```

**Agent-vs-automation-argumentet:**  
En workflow triggar på "deal = proposal → skapa quote." Den kan inte välja line items, prisnivå, om rabatt ska erbjudas, eller navigera approval-flödet baserat på kontextuellt värde. En agent läser leadets kontext (roll, bolagsstorlek, behov, kanal) och resonerar om hela offertstrukturen — inte bara om den ska skapas.

---

## Spelledarens ansvar (PREP)

1. Injicera ett lead med rik kontext:
   - Namn: `Erik Magnusson (sim-{RUN_ID})`
   - Email: `erik.sim.{RUN_ID}@techbolag.se`
   - Roll: CTO, 40-personers techbolag
   - Behov: "Vi behöver strukturera vår orderhantering och fakturering — idag kör vi allt i Excel."
   - Källa: website, Google
2. Skapa en produkt i katalogen att offera mot (om saknas): "FlowWink Professional — 12 månader"
3. Injicera dispatch-mission med lead_id + product_id

---

## Dispatch-mission (till ClawWink)

```
AUTONOMOUS MISSION — SIM-016 Full Q2C Lead-to-Cash

Lead: Erik Magnusson, lead_id={LEAD_ID}
Kontext: CTO, 40-personers techbolag, söker orderhantering + fakturering. Källa: Google.

Din uppgift:
1. Läs flowwink://briefing
2. qualify_lead — sätt score baserat på kontext (CTO + 40 ppl + aktivt behov)
3. manage_deal — skapa deal i stage=prospecting med lead_id kopplat
4. manage_quote — skapa offert kopplad till deal_id:
   - Lägg till minst 1 line item (välj lämplig produkt ur katalogen)
   - Prissätt baserat på bolagsstorlek
   - Kör request_approval — om värde > 25k SEK, notera om godkännande krävs
5. manage_quote action=send — generera e-sign-länk (acceptera att kund signerar manuellt)
6. manage_invoice action=create kopplad till quote (simulera accepterad quote)
7. manage_invoice action=send — skicka faktura med Stripe-betalningslänk
8. openclaw_report_finding för varje steg som lyckas eller misslyckas

Rapportera MISSION_COMPLETE med full Q2C-sammanfattning:
- Lead score
- Deal ID
- Quote ID + total_cents
- Invoice ID + public payment URL (om genererad)
- Vilka steg som blockerades och varför
```

---

## Assertions (VERIFY)

| Assert | Verktyg | Pass-kriterie |
|--------|---------|---------------|
| Lead qualificerad | `qualify_lead` | score > 50 |
| Deal skapad | `manage_deal` | deal_id returneras, stage=prospecting |
| Quote skapad med line item | `manage_quote` | quote_id returneras, total_cents > 0 |
| Approval-gate navigerad | `manage_quote request_approval` | returnerar approved/pending utan krasch |
| Quote skickad | `manage_quote send` | accept_token eller public_url returneras |
| Invoice skapad | `manage_invoice create` | invoice_id returneras |
| Invoice skickad med betalningslänk | `manage_invoice send` / `send_invoice_email` | email skickat, Stripe-länk i svar |
| Findings rapporterade | `openclaw_report_finding` | minst 3 findings |

---

## Persist-uppdrag (steg 4)

Efter verifiering: dispatcha ett persist-uppdrag där ClawWink skriver in "Full Q2C Protocol" i sin `AGENTS.md` — inklusive approval-gaten och när en quote ska skapas (score-trösklar, bolagsstorlek).

---

## Agent-vs-automation: vad agenten gör som ett workflow inte kan

| Beslut | Workflow | Agent |
|--------|----------|-------|
| Ska vi offera? | Triggar på deal-stage | Bedömer score + kontext + timing |
| Vilka line items? | Hårdkodad produkt | Väljer baserat på bolagsstorlek och behov |
| Prisnivå? | Fast lista | Anpassar efter ICP-match |
| Approval-gate? | Tröskel-trigger | Förstår varför gaten finns, navigerar den |
| Ska vi skicka nu? | Alltid vid steg X | Bedömer om kontexten är redo |

---

## Förväntade gap-findings

- `invoice_from_quote` som enskilt MCP-tool kanske saknas — agenten ska notera detta
- Stripe webhook-verifiering är asynkron — agenten kan inte verifiera "paid" i realtid
- `send_invoice_email` kanske inte är exponerad som MCP-skill (sitter som edge function) — agent ska flagga

---

## Handbook-output

Kapitelmaterial för: *"Lead till betalning — det fullständiga autonoma flödet"*  
Bevis: en agent som resonerar om offertstruktur och navigerar approval-flödet är fundamentalt annorlunda än en workflow som skapar en quote på ett fast villkor.
