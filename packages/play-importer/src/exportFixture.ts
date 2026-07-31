/**
 * Exports one scene of a parsed play in the exact shape the API's
 * `getSceneDialogue` will return once migration 004 lands — so the frontend can
 * be built and judged against real beat data with no database and no Polly.
 *
 * Deliberately reads `output/<slug>/rows.json` rather than the XML: that file is
 * what a real import would insert, so a fixture generated from it can't drift
 * from what the database will hold.
 *
 *   npm run export:fixture -- --slug merry-wives-of-windsor --act II --scene I \
 *     --out ../../frontend/src/data/fixtures/merry-wives-ii-i.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BuiltPlay, LineRow, StageDirectionRow } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mirrors api's DialogueEntryRow, plus the beat/block fields. */
type FixtureEntry =
  | { type: "stage"; text: string }
  | {
    type: "speech";
    lineId: string;
    lineNumber: number;
    blockId: string;
    beatNumber: number;
    text: string;
    sourceLines: string[];
    sharesFirstSourceLine: boolean;
    isVerse: boolean;
    speakerIds: string[];
    speakerNames: string[];
  };

function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      act: { type: "string" },
      scene: { type: "string" },
      out: { type: "string" },
    },
  });
  const { slug, act, scene, out } = values;
  if (!slug || !act || !scene || !out) {
    throw new Error("pass --slug <output-dir> --act <label> --scene <label> --out <path>");
  }

  const rowsPath = join(__dirname, "..", "output", slug, "rows.json");
  const built: BuiltPlay = JSON.parse(readFileSync(rowsPath, "utf8"));

  const lines = built.lines.filter((l) => l.act === act && l.scene === scene);
  if (lines.length === 0) {
    const available = [...new Set(built.lines.map((l) => `${l.act}/${l.scene}`))];
    throw new Error(`no lines for ${act}/${scene}. Available: ${available.join(", ")}`);
  }
  const directions = built.stageDirections.filter((d) => d.act === act && d.scene === scene);

  const nameById = new Map(built.characters.map((c) => [c.id, c.name]));
  const speakersByLine = new Map<string, string[]>();
  for (const ls of built.lineSpeakers) {
    const ids = speakersByLine.get(ls.line_id) ?? [];
    ids.push(ls.character_id);
    speakersByLine.set(ls.line_id, ids);
  }

  // Same interleave as PlaysService.getSceneDialogue: a direction with
  // after_line_number = N sorts immediately before beat N.
  type Sortable = { sortKey: number; tiebreak: number; entry: FixtureEntry };
  const sortable: Sortable[] = [
    ...lines.map((l: LineRow): Sortable => {
      // Ordered by character name for determinism, matching the API's
      // array_agg(... ORDER BY c.name) — line_speakers is an unordered join.
      const ids = (speakersByLine.get(l.id) ?? []).slice().sort((a, b) =>
        (nameById.get(a) ?? "").localeCompare(nameById.get(b) ?? "")
      );
      return {
        sortKey: l.line_number,
        tiebreak: 1,
        entry: {
          type: "speech",
          lineId: l.id,
          lineNumber: l.line_number,
          blockId: l.block_id,
          beatNumber: l.beat_number,
          text: l.text,
          sourceLines: l.source_lines,
          sharesFirstSourceLine: l.shares_first_source_line,
          isVerse: l.is_verse,
          speakerIds: ids,
          speakerNames: ids.map((id) => nameById.get(id) ?? "(unknown)"),
        },
      };
    }),
    ...directions.map((d: StageDirectionRow): Sortable => ({
      sortKey: d.after_line_number,
      tiebreak: 0,
      entry: { type: "stage", text: d.text },
    })),
  ];
  sortable.sort((a, b) => a.sortKey - b.sortKey || a.tiebreak - b.tiebreak);

  const fixture = {
    play: { id: built.play.id, title: built.play.title },
    act,
    scene,
    description: lines[0].scene_description,
    characters: [...new Set(lines.flatMap((l) => speakersByLine.get(l.id) ?? []))].map((id) => ({
      id,
      name: nameById.get(id) ?? "(unknown)",
    })),
    entries: sortable.map((s) => s.entry),
  };

  const outPath = resolve(process.cwd(), out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2), "utf8");

  const speech = fixture.entries.filter((e) => e.type === "speech");
  const blocks = new Set(speech.map((e) => (e as { blockId: string }).blockId));
  console.log(
    `${built.play.title} ${act}.${scene}: ${speech.length} beats in ${blocks.size} blocks, ` +
      `${directions.length} stage directions -> ${outPath}`
  );
}

main();
