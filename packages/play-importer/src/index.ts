import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildRows } from "./buildRows.js";
import { ingestPlay } from "./ingest.js";
import { parsePlayXml } from "./parseXml.js";
import { renderCharacterSummary, renderScript } from "./render.js";

// fileURLToPath + dirname rather than import.meta.dirname — the latter needs
// Node 20.11+/21.2+ specifically, not just >=20.
const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_BASE =
  "https://raw.githubusercontent.com/rufuspollock-okfn/shakespeare-material/master/texts/moby";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadXml(opts: {
  play?: string;
  file?: string;
}): Promise<{ xml: string; sourceUrl: string | null }> {
  if (opts.file) {
    return { xml: readFileSync(opts.file, "utf8"), sourceUrl: null };
  }
  if (opts.play) {
    const url = `${SOURCE_BASE}/${opts.play}_moby.xml`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
    return { xml: await res.text(), sourceUrl: url };
  }
  throw new Error("pass --play <slug> (e.g. merry_wives_of_windsor) or --file <path>");
}

async function main() {
  const { values } = parseArgs({
    options: {
      play: { type: "string" },
      file: { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const { xml, sourceUrl } = await loadXml(values);
  const parsed = parsePlayXml(xml);
  const built = buildRows(parsed, sourceUrl);

  const slug = slugify(values.play ?? parsed.title);
  const outDir = values["out-dir"] ?? join(__dirname, "..", "output", slug);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "script.txt"), renderScript(parsed), "utf8");
  writeFileSync(join(outDir, "characters.txt"), renderCharacterSummary(built), "utf8");
  writeFileSync(join(outDir, "rows.json"), JSON.stringify(built, null, 2), "utf8");

  console.log(
    `parsed "${built.play.title}": ${built.characters.length} characters, ` +
      `${built.lines.length} lines across ${new Set(built.lines.map((l) => `${l.act}/${l.scene}`)).size} scenes, ` +
      `${built.stageDirections.length} stage directions`
  );
  console.log(`review artifacts written to ${outDir}/ (script.txt, characters.txt, rows.json)`);

  if (values["dry-run"]) {
    console.log("--dry-run: not touching the database. Review the files above first.");
    return;
  }

  await ingestPlay(built);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
