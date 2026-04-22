# SIM-021: Recruitment MCP Gap — Ny modul, ej driftsatt

**Status:** ✅ Completed (oväntad finding)  
**Spelledare:** Claude Code  
**Operatör:** ClawWink (`clawwink.froste.eu`)  
**Datum:** 2026-04-22  
**OBJ:** OBJ-004 (Platform reliability), OBJ-001 (Operational health)

---

## Vad som hände

SIM-021 designades som ett HR-onboarding-scenario. Under förberedelsen upptäcktes istället
två separata MCP-ytproblem i FlowWinks nyligen driftsatta recruitment-modul.

---

## Fynd A — manage_employee: schema/implementation-mismatch

**Verktyg:** `manage_employee`  
**Problem:** Tool-schemat deklarerar `action: enum [create, update, search, deactivate]`.  
Implementationen stöder `list` och `get` men de syns inte i schemat.  
**Effekt:** ClawWink validerar mot schemat och vägrar anropa `list` — trots att det fungerar.  
**Typ:** Schema gap. Agenten gör rätt sak (litar på kontraktet) men kontraktet är fel.

---

## Fynd B — Recruitment-modul: MCP-tools live men DB-tabeller saknas

**Verktyg:** `manage_job_posting`, `summarize_candidate_pipeline`, `parse_resume`  
**Problem:** Recruitment-modulen mergades till `flowwink` 2026-04-22. MCP-tools är  
exponerade och syns i tool-list (129 total). Men Supabase-migrationerna har inte körts —  
tabellerna `job_postings` och `applications` existerar inte i databasen.  
**Felmeddelande:** `"Unknown db table: job_postings. Generic CRUD is not enabled for this table."`  
**Effekt:** Alla 6 recruitment-skills returnerar fel trots att de syns som tillgängliga.  
**Typ:** Deployment gap. Kod live, infrastruktur inte.

---

## Varför detta stödjer handbokens tes (kap 14)

Chapter 14 ("Making SaaS Agent-Ready") beskriver moat-paradoxen: en plattform kan inte
vara "agent-ready" med felaktiga scheman eller halvdriftsatta moduler. En människa hade
aldrig testat recruitment-API:t för att se att det inte fungerar — den syntes i UI:t som
ny feature. Agenten testade det direkt och fick felen inom sekunder.

> *Agents expose deployment gaps that humans never find — because agents actually
> call the tools, while humans read the documentation.*

---

## Nästa steg

1. Kör recruitment-DB-migrationerna på Supabase (`20260422094023_94e29a72...`)
2. Uppdatera `manage_employee` tool-schema med `list` och `get` i enum
3. Re-kör SIM-021 med fungerande recruitment-yta: job posting → kandidater → pipeline-sweep
