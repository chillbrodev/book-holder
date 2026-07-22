# play-importer

Parses a Moby Shakespeare XML play (source: [rufuspollock-okfn/shakespeare-material](https://github.com/rufuspollock-okfn/shakespeare-material))
and loads it into CockroachDB. Run by hand, one play at a time — not part of the live product path (at
least not yet; see `docs/PROJECT_PLAN.md` §7 for why other plays are cut from MVP scope but the importer is
built generically anyway).

## Workflow: review before you import

Every run writes human-readable review artifacts **before** touching the database, so you can check the
parse is correct before anything reaches CockroachDB or an embedder:

```
npm run import:play -- --play merry_wives_of_windsor --dry-run
```

(or `--file <path-to-xml>` to parse a file you already have locally, no network fetch)

This writes to `packages/play-importer/output/<slug>/` (gitignored):

- **`script.txt`** — the play reconstructed as plain text: act/scene headers, stage directions bracketed
  inline (`[Within] Who's there?`) and between speeches (`[Enter SHALLOW, SLENDER, and SIR HUGH EVANS]`),
  speaker name(s) before each speech. Read this next to the real play text to catch parsing mistakes.
- **`characters.txt`** — every character with its best-effort description and line count. Character identity
  is derived from actual `<SPEAKER>` usage in the script body, not the `<PERSONAE>` cast list (the two don't
  line up 1:1 in the real source — e.g. PERSONAE has "Host of the Garter Inn." but the script only ever says
  "Host"; "First Servant"/"Second Servant" never appear in PERSONAE at all). This file is how you check that
  pass worked — descriptions matched where they should, and roles with no PERSONAE match still got a row
  with no description, correctly, rather than being dropped.
- **`rows.json`** — the exact rows (with UUIDs) that a real run would insert.

Once that looks right, drop `--dry-run` to actually write to `COCKROACHDB_URL` (from `.env`).

## Schema notes worth knowing before reading the code

- `lines` has no `character_id`. Speeches can have more than one `<SPEAKER>` (real, not hypothetical — Merry
  Wives has PAGE/SHALLOW/SLENDER jointly speaking one line). `line_speakers` is a many-to-many join instead,
  so a joint line correctly shows up for every character involved, e.g. when Slender is rehearsed alone.
- `lines.embedding` / `mistake_log.embedding` are nullable `VECTOR(1536)` columns, left `NULL` here on
  purpose — embedding generation is a separate follow-up pass once an embedding model is chosen, not part of
  this importer.
- `stage_directions` (scene-level cues like "Exeunt") isn't in the original `docs/PROJECT_PLAN.md` data
  model — added because the parser already walks those nodes, and dropping real blocking content would've
  been arbitrary.

## Parsing rules handled

Per `docs/PROJECT_PLAN.md` §6, confirmed against the real Merry Wives of Windsor source file:

1. Stage directions nested inside `<LINE>` — extracted, not left in the spoken text.
2. `<PGROUP>` — flattened, each `<PERSONA>` inside becomes its own character.
3. `<INDUCT>` — top-level sibling of `<ACT>`, own act-equivalent ("INDUCTION"). Not present in Merry Wives,
   but handled for other plays in the corpus.
4. `<PROLOGUE>` — sibling of `<SCENE>` within an act, blank `<SPEAKER>` maps to a synthetic "Chorus" role.
5. Speaker `ALL` (case-insensitive) — maps to a synthetic "All" role.
6. Speakers with no `<PERSONA>` match ("First Citizen", "Host", etc.) — still get a character row, just with
   no description.
7. Minor transcription inconsistencies (this is a 1990s transcription) — handled by deriving identity from
   usage rather than requiring an exact `<PERSONAE>` join.
