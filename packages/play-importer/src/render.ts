import type { BuiltPlay, ParsedPlay } from "./types.js";

/** Reconstructs the play as plain text from the intermediate parse model —
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

/** One line per character: name, best-effort description, synthetic flag, and
 * how many lines they speak — for sanity-checking the PERSONAE fuzzy-match
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
      `${r.name}${r.isSynthetic ? " [synthetic]" : ""} — ${r.description} — ${r.lineCount} line(s)`
  );

  return [`${built.characters.length} characters:`, "", ...lines].join("\n");
}
