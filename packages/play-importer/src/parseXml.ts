import { DOMParser } from "@xmldom/xmldom";
import type {
  ParsedLine,
  ParsedPersona,
  ParsedPlay,
  ParsedScene,
  SceneItem,
  SpeechItem,
} from "./types.js";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Structural shape we actually need from xmldom's DOM nodes — declared locally
// instead of importing xmldom's own types, since this hasn't been type-checked
// against the real package yet (Node isn't installed on this machine as of
// writing). Verify this compiles once `npm install` has run.
interface XmlNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: { length: number; item(i: number): XmlNode | null };
  tagName?: string;
}

function children(node: XmlNode, tag?: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i);
    if (child && child.nodeType === ELEMENT_NODE && (!tag || child.tagName === tag)) {
      out.push(child);
    }
  }
  return out;
}

/** Text of direct TEXT_NODE children only — used on <LINE> so nested
 * <STAGEDIR> text isn't mixed into the spoken text. */
function directText(node: XmlNode): string {
  let text = "";
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i);
    if (child && child.nodeType === TEXT_NODE) text += child.nodeValue ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Full descendant text — used everywhere except <LINE>, where mixed content matters. */
function fullText(node: XmlNode): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function parseLine(lineEl: XmlNode): ParsedLine {
  const stagedirs = children(lineEl, "STAGEDIR");
  const stageDirection = stagedirs.length > 0 ? fullText(stagedirs[0]) : null;
  return { text: directText(lineEl), stageDirection };
}

function parseSpeech(speechEl: XmlNode): { speakerNames: string[]; items: SpeechItem[] } {
  const speakerNames = children(speechEl, "SPEAKER").map(fullText);

  // Walk direct children in document order, not children(speechEl, "LINE") in
  // isolation — <STAGEDIR> can also be a direct child of <SPEECH>, interleaved
  // between <LINE>s (e.g. "Knocks" mid-speech), and that position matters.
  const items: SpeechItem[] = [];
  for (let i = 0; i < speechEl.childNodes.length; i++) {
    const child = speechEl.childNodes.item(i);
    if (!child || child.nodeType !== ELEMENT_NODE) continue;
    if (child.tagName === "LINE") {
      items.push({ kind: "line", ...parseLine(child) });
    } else if (child.tagName === "STAGEDIR") {
      items.push({ kind: "action", text: fullText(child) });
    }
  }

  return { speakerNames, items };
}

function extractActLabel(actTitleText: string): string {
  const m = actTitleText.match(/^ACT\s+([IVXLCDM]+)/i);
  return m ? m[1].toUpperCase() : actTitleText.trim();
}

function extractSceneLabel(sceneTitleText: string): { scene: string; description: string | null } {
  const m = sceneTitleText.match(/^SCENE\s+([IVXLCDM]+)\.?\s*(.*)$/i);
  if (!m) return { scene: sceneTitleText.trim(), description: null };
  return { scene: m[1].toUpperCase(), description: m[2].trim() || null };
}

/** Speeches and scene-level <STAGEDIR> siblings, in document order. */
function parseSceneItems(container: XmlNode): SceneItem[] {
  const items: SceneItem[] = [];
  for (let i = 0; i < container.childNodes.length; i++) {
    const child = container.childNodes.item(i);
    if (!child || child.nodeType !== ELEMENT_NODE) continue;
    if (child.tagName === "SPEECH") {
      items.push({ kind: "speech", ...parseSpeech(child) });
    } else if (child.tagName === "STAGEDIR") {
      items.push({ kind: "stageDirection", text: fullText(child) });
    }
  }
  return items;
}

function parseScenesOfAct(actEl: XmlNode, actLabel: string, actOrder: number): ParsedScene[] {
  const scenes: ParsedScene[] = [];
  let sceneOrder = 0;

  // PROLOGUE is a sibling of SCENE within an ACT, often with a blank <SPEAKER>
  // (the Chorus) — treated as a pseudo-scene ordered before SCENE I.
  for (const prologueEl of children(actEl, "PROLOGUE")) {
    scenes.push({
      act: actLabel,
      actOrder,
      scene: "PROLOGUE",
      sceneOrder: sceneOrder++,
      sceneDescription: null,
      items: parseSceneItems(prologueEl),
    });
  }

  for (const sceneEl of children(actEl, "SCENE")) {
    const titleEl = children(sceneEl, "TITLE")[0];
    const { scene, description } = extractSceneLabel(titleEl ? fullText(titleEl) : "");
    scenes.push({
      act: actLabel,
      actOrder,
      scene,
      sceneOrder: sceneOrder++,
      sceneDescription: description,
      items: parseSceneItems(sceneEl),
    });
  }

  return scenes;
}

export function parsePlayXml(xml: string): ParsedPlay {
  const doc = new DOMParser().parseFromString(xml, "application/xml") as unknown as {
    documentElement: XmlNode;
  };
  const playEl = doc.documentElement;

  const titleEl = children(playEl, "TITLE")[0];
  const title = titleEl ? fullText(titleEl) : "Untitled";

  const personae: ParsedPersona[] = [];
  const personaeEl = children(playEl, "PERSONAE")[0];
  if (personaeEl) {
    for (let i = 0; i < personaeEl.childNodes.length; i++) {
      const child = personaeEl.childNodes.item(i);
      if (!child || child.nodeType !== ELEMENT_NODE) continue;
      if (child.tagName === "PERSONA") {
        personae.push({ rawText: fullText(child) });
      } else if (child.tagName === "PGROUP") {
        // Flatten grouped personae (e.g. "FORD"/"PAGE" under one GRPDESCR) —
        // the group description itself isn't needed by the app.
        for (const personaEl of children(child, "PERSONA")) {
          personae.push({ rawText: fullText(personaEl) });
        }
      }
    }
  }

  const scenes: ParsedScene[] = [];
  let actOrder = 0;

  // INDUCT is a top-level sibling of ACT (not present in Merry Wives, but real
  // in e.g. Taming of the Shrew) — treated as its own act-equivalent.
  for (const inductEl of children(playEl, "INDUCT")) {
    scenes.push(...parseScenesOfAct(inductEl, "INDUCTION", actOrder++));
  }

  for (const actEl of children(playEl, "ACT")) {
    const actTitleEl = children(actEl, "TITLE")[0];
    const actLabel = extractActLabel(actTitleEl ? fullText(actTitleEl) : "");
    scenes.push(...parseScenesOfAct(actEl, actLabel, actOrder++));
  }

  return { title, personae, scenes };
}
