import { blockVerseLines, groupIntoBlocks } from "./blocks.js";
import { SEGMENT_LIMITS } from "./segment.js";
import type { BuiltPlay, ParsedPlay } from "./types.js";

/** Reconstructs the play as plain text from the intermediate parse model,
 * meant to be read next to the real play text to catch parsing mistakes
 * before anything is written to a file that gets embedded or imported. */
export function renderScript(parsed: ParsedPlay): string {
  const out: string[] = [parsed.title.toUpperCase(), ""];

  let currentAct: string | null = null;
  for (const scene of parsed.scenes) {
    if (scene.act !== currentAct) {
      currentAct = scene.act;
      out.push(`ACT ${currentAct}`, "");
    }

    const sceneHeader = scene.sceneDescription
      ? `SCENE ${scene.scene}. ${scene.sceneDescription}`
      : `SCENE ${scene.scene}`;
    out.push(sceneHeader, "");

    for (const item of scene.items) {
      if (item.kind === "stageDirection") {
        out.push(`  [${item.text}]`, "");
        continue;
      }

      out.push(`${item.speakerNames.join(", ")}:`);
      for (const speechItem of item.items) {
        if (speechItem.kind === "action") {
          out.push(`  [${speechItem.text}]`);
          continue;
        }
        const prefix = speechItem.stageDirection ? `[${speechItem.stageDirection}] ` : "";
        out.push(`  ${prefix}${speechItem.text}`);
      }
      out.push("");
    }
  }

  return out.join("\n");
}

/**
 * The play as the app will actually segment it, every speech-block with its
 * verse lines above the beats they were cut into. This is the file to read when
 * checking a parse: the `verse:` half shows the join (broken words rejoined,
 * dashes left alone), the `beats:` half shows the split.
 *
 * Beats over the ceiling are marked `!` so they can be grepped out of a
 * whole-corpus run; a handful is expected (a sentence with no internal `;`/`:`
 * is left whole on purpose), a flood means the rules need another look.
 */
export function renderBeats(built: BuiltPlay): string {
  const nameById = new Map(built.characters.map((c) => [c.id, c.name]));
  const speakersByLine = new Map<string, string[]>();
  for (const ls of built.lineSpeakers) {
    const names = speakersByLine.get(ls.line_id) ?? [];
    names.push(nameById.get(ls.character_id) ?? "(unknown)");
    speakersByLine.set(ls.line_id, names);
  }

  // Stage directions sort immediately before the beat they precede, matching
  // PlaysService.getSceneDialogue's interleave.
  type Item = { sortKey: number; tiebreak: number; render: () => string[] };
  const bySceneKey = new Map<string, { act: string; scene: string; description: string | null; items: Item[] }>();

  const sceneEntry = (act: string, scene: string, actOrder: number, sceneOrder: number, description: string | null) => {
    const key = `${String(actOrder).padStart(3, "0")}|${String(sceneOrder).padStart(3, "0")}|${act}|${scene}`;
    let entry = bySceneKey.get(key);
    if (!entry) {
      entry = { act, scene, description, items: [] };
      bySceneKey.set(key, entry);
    }
    return entry;
  };

  for (const beats of groupIntoBlocks(built.lines)) {
    const first = beats[0];
    const entry = sceneEntry(first.act, first.scene, first.act_order, first.scene_order, first.scene_description);
    entry.items.push({
      sortKey: first.line_number,
      tiebreak: 1,
      render: () => {
        const verseLines = blockVerseLines(beats);
        const speakers = (speakersByLine.get(first.id) ?? []).join(", ");
        const prefix = first.stage_direction ? `[${first.stage_direction}] ` : "";
        const out = [
          `${speakers} [${first.is_verse ? "verse" : "prose"}] — ` +
            `${verseLines.length} verse line(s) -> ${beats.length} beat(s)`,
        ];
        if (verseLines.length > 1) {
          out.push("  verse:");
          for (const v of verseLines) out.push(`    | ${v}`);
          out.push("  beats:");
        }
        for (const beat of beats) {
          const flag = beat.text.length > SEGMENT_LIMITS.MAX_BEAT_CHARS ? "!" : " ";
          out.push(`   ${flag}${String(beat.beat_number).padStart(2)}| ${prefix}${beat.text}`);
        }
        return out;
      },
    });
  }

  for (const direction of built.stageDirections) {
    const entry = sceneEntry(
      direction.act,
      direction.scene,
      direction.act_order,
      direction.scene_order,
      null
    );
    entry.items.push({
      sortKey: direction.after_line_number,
      tiebreak: 0,
      render: () => [`  [${direction.text}]`],
    });
  }

  const out: string[] = [built.play.title.toUpperCase(), "", ...renderBeatSummary(built), ""];
  for (const key of [...bySceneKey.keys()].sort()) {
    const entry = bySceneKey.get(key)!;
    out.push(
      `${"=".repeat(72)}`,
      `ACT ${entry.act} — SCENE ${entry.scene}${entry.description ? `. ${entry.description}` : ""}`,
      ""
    );
    entry.items
      .sort((a, b) => a.sortKey - b.sortKey || a.tiebreak - b.tiebreak)
      .forEach((item) => out.push(...item.render(), ""));
  }

  return out.join("\n");
}

/** The anomaly counts a whole-corpus run is checked against. */
export function renderBeatSummary(built: BuiltPlay): string[] {
  const beats = built.lines;
  const blocks = groupIntoBlocks(beats);
  const lengths = beats.map((b) => b.text.length).sort((a, b) => a - b);
  const at = (q: number) => lengths[Math.floor(lengths.length * q)] ?? 0;
  const multiLineBeats = beats.filter((b) => b.source_lines.length > 1).length;
  const overCeiling = beats.filter((b) => b.text.length > SEGMENT_LIMITS.MAX_BEAT_CHARS);
  const beatsPerBlock = blocks.map((b) => b.length);

  let verseLineCount = 0;
  let repeatedInBlock = 0;
  for (const block of blocks) {
    const verse = blockVerseLines(block);
    verseLineCount += verse.length;
    for (let i = 1; i < verse.length; i++) if (verse[i] === verse[i - 1]) repeatedInBlock++;
  }
  const sharedAcrossBeats = beats.filter((b) => b.shares_first_source_line).length;

  return [
    "SUMMARY",
    `  verse lines ${verseLineCount} -> beats ${beats.length} in ${blocks.length} blocks`,
    `  beats spanning >1 verse line: ${multiLineBeats}` +
      `  |  verse lines straddling a beat boundary: ${sharedAcrossBeats}`,
    `  beat chars: p50 ${at(0.5)}  p90 ${at(0.9)}  max ${lengths[lengths.length - 1] ?? 0}`,
    `  beats over ${SEGMENT_LIMITS.MAX_BEAT_CHARS} chars: ${overCeiling.length}` +
      ` (${((100 * overCeiling.length) / (beats.length || 1)).toFixed(1)}%) — marked "!" below`,
    `  monologue blocks (>=6 beats): ${beatsPerBlock.filter((n) => n >= 6).length}` +
      `  |  longest block: ${Math.max(0, ...beatsPerBlock)} beats`,
    `  repeated adjacent verse lines within a block (song refrains, kept): ${repeatedInBlock}`,
    `  verse blocks: ${blocks.filter((b) => b[0].is_verse).length} of ${blocks.length}` +
      ` (${((100 * blocks.filter((b) => b[0].is_verse).length) / (blocks.length || 1)).toFixed(0)}%)`,
  ];
}

/** One line per character: name, best-effort description, synthetic flag, and
 * how many beats they speak, for sanity-checking the PERSONAE fuzzy-match
 * pass (e.g. did "Host" pick up its description? do genuinely undescribed
 * roles like "First Servant" correctly show no description, not an error?). */
export function renderCharacterSummary(built: BuiltPlay): string {
  const lineCounts = new Map<string, number>();
  for (const ls of built.lineSpeakers) {
    lineCounts.set(ls.character_id, (lineCounts.get(ls.character_id) ?? 0) + 1);
  }

  const rows = built.characters
    .map((c) => ({
      name: c.name,
      description: c.description ?? "(no description)",
      isSynthetic: c.is_synthetic,
      lineCount: lineCounts.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.lineCount - a.lineCount);

  const lines = rows.map(
    (r) =>
      `${r.name}${r.isSynthetic ? " [synthetic]" : ""} — ${r.description} — ${r.lineCount} beat(s)`
  );

  return [`${built.characters.length} characters:`, "", ...lines].join("\n");
}
