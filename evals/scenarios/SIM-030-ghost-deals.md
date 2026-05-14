# SIM-030: The Ghost Deals — Anna Städar Pipeline Ingen Bett Henne Titta På

**Status:** ✅ Genomförd (2026-05-14)  
**Spelledare:** Claude Code  
**Operatör:** Anna/ClawOne (Sales/CRM, ensam)  
**Tid dispatch → rapport:** ~8 minuter  
**Hypotes:** Kan Anna autonomt triage:a en hel pipeline, skilja spöken från aktiva deals, och fatta rätt beslut om varje — utan att spelledaren pekar ut vad som är fel?

---

## Varför inte ett workflow?

Ett workflow kan flagga deals vars expected_close passerat. Men vad gör man med flaggan? Är det en dead deal, en akut deal, eller en deal som blockeras av en annan del av systemet? Det beror på kontext.

Anna ser kontexten.

---

## Scenariot

Anna fick inga ledtrådar om vad som var fel. Uppdraget: "Gör en pipeline-sweep. Hitta deals som spökar. Ta beslut."

---

## Annas Triage — 16 Deals

Anna hämtade alla deals och analyserade dem en för en. Här är hennes egna beslut:

### 🔴 Ghost Deals med passerat deadline

**Berg-Tek Industri AB** (`f156018a`) — 588 000 SEK | `proposal`
- `expected_close: 2026-05-11` — passerat 3 dagar sedan
- 8 follow-up mail skickade sedan skapandet. Thomas Berg (VD) har inte svarat.
- Kontexten: Styrelsemötet var 2026-05-11. Ingen bekräftelse kom.
- **Annas beslut:** "Ghost deal. Skickar sista mail. Om inget svar inom 24h → dead."
- **Åtgärd:** Nytt mail skickat + CRM-task skapad.

**Kraftstad Energi AB** (`b7ad3205`) — 120 000 SEK | `proposal`
- `expected_close: 2026-05-12` — passerat igår
- Offert skickad. Styrelsemöte var 2026-05-14 kl 15:00.
- **Annas beslut:** "Akut — styrelsemötet var idag. Följ upp nu."
- **Åtgärd:** Mail skickat + CRM-task skapad.

### 🟡 Högrisk men inte ghost

**Apex Nordic** (`268a515e`) — 240 000 SEK | `proposal`
- `expected_close: 2026-06-04` — inte passerat
- Men befintligt avtal föll ut 2026-05-04. 5 mail skickade.
- **Annas beslut:** "Hög risk, inte ghost. Obetalda faktura — Peters domän. Eskalerar."
- *(INV-2026-001, 23 125 SEK — samma faktura som SIM-027, 028, 029)*

**Soltech AB** (`d9d006f8`) — 380 000 SEK | `negotiation`
- Förfallen faktura på 45 000 SEK.
- **Annas beslut:** "Blockerad av finans. Peters domän. Eskalerar."

### ⚪ Det Oväntade Fyndet

**Erik Johanssons deals** (`52fde19b` + `a5cd7aed`) — 220 000 + 480 000 SEK
- Auto-genererade leads, inga kontaktuppgifter, ingen aktivitet.
- Skapades 2026-05-13 med notering om "Erik Johansson".
- **Annas beslut:** "Dessa är spöken. Inget kontaktuppgifter. Vem är Erik Johansson?"
- *(Det är deals från SIM-025:s offboarding — Anna hittade sina egna sim-artefakter.)*

---

## Den Röda Tråden — Avslutad

INV-2026-001 (Apex Nordic, 23 125 SEK) har nu dykt upp i **fyra sims**:

| SIM | Kontext | Agent |
|-----|---------|-------|
| 027 | Anna identifierar som förfallen, vägrade dunning | Anna |
| 027 | Peter kan inte stänga perioden | Peter |
| 028 | ClawWink poolar 78 125 SEK total skuld | ClawWink |
| 029 | Blockerar 422 400 SEK kontraktsförnyelse | ClawWink |
| **030** | **Blockerar 240 000 SEK deal-progression** | **Anna** |

Fem separata tillfällen. Fyra sims. Tre agenter. Ingen koppling var skriptad.

---

## Analys

### Triage utan instruktion

Anna klassificerade 16 deals på egen hand: ghost, akut, högrisk, blockerad, testdata. Varje klassificering hade en motivering och en konkret åtgärd. Det är inte en lista — det är affärsintelligens.

### Domängränserna håller

Två gånger hittade Anna deals blockerade av obetalda fakturor och eskalerade direkt till Peter — utan att bli påmind om regeln. AGENTS.md lever i agenten, inte i dispatchingen.

### Det Självrefererande Fyndet

Anna hittade Eriks deals från SIM-025 och flaggade dem som "mysterium". Hon visste inte att de var sim-artefakter. Hon såg bara: inga kontaktuppgifter, ingen aktivitet, ingen kontext. Rätt slutsats, fel förklaring.

Det är precis vad en bra säljare skulle göra.

### Plattformsbug Återfunnen

`manage_deal` `update`-action tolkar `notes`-parametern som `stage`. Anna hittade buggen och gick runt den (skapade CRM-tasks istället). Agenten löste konsekvensen av buggen autonomt.

---

## Plattformsfynd

- `deal_stale_check` → fungerar, returnerar deals med passerade closingdatum
- `lead_pipeline_review` → fungerar, 15 leads, 0 stagnanta
- `manage_deal` update + notes → **bug**: notes-parameter tolkas som stage
- `send_email` / CRM-aktiviteter → fungerar (mail skickade till Berg-Tek och Kraftstad)
- `create_task` → fungerar, tasks skapade som workaround för notes-buggen

---

## Nästa SIM

INV-2026-001 blockerar nu tre separata affärshändelser. Det är materialet för ett kapitel om systemisk intelligens: hur ett enda olöst problem eskalerar genom ett företag tills det blir synligt från alla håll.

**SIM-031-idé: The Resolution** — Peter löser INV-2026-001. Vad händer i resten av systemet? Öppnar det Apex-förnyelsen? Frigör det Soltech-dealen? Kan en enda betalning ha dominoeffekt genom hela plattformen?
