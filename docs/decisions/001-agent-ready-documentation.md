# ADR-001: Agent-Ready Documentation

## Status

Accepted

## Date

2026-07-15

## Context

Sibling libraries (libbmp, libipfix, libdom, shaggy, …) use progressive-disclosure
docs so AI agents and humans orient without loading full sources.

## Decision

Adopt:

- `AGENTS.md` as the concise entry point with directives and ADR index
- `CLAUDE.md` pointing at `AGENTS.md`
- `ARCHITECTURE.md` as codemap, invariants, and deliberate absences
- `docs/DOMAIN.md` for map / utility domain knowledge
- `docs/decisions/` for ADRs
- `docs/README.md` as documentation index
- `TODO.md` as the living major-work tracker

## Consequences

- Agents orient quickly; design decisions are durable and reviewable

## Alternatives considered

- Single large README — rejected; crowds context and rots
