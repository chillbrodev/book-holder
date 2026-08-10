# The Book Holder — brand & style guide

*v1 — living document, started July 2026. Update as each new screen is designed.*

---

## 1. Brand foundation

**What it is:** A rehearsal partner with a memory, for actors without a scene partner on demand. Voices every other character, tracks what's been mastered, tells you what to work on next.

**Where the name comes from:** In Shakespeare's own company, the book holder was the backstage crew member who held the script and fed actors their forgotten lines. This app does that job, with an AI that remembers.

**Design principle — warmth as seasoning, not the base:** The Shakespearean, candlelit mood lives in headline moments — the wordmark, the shelf, act dividers, key accents. Functional surfaces (the script itself, the rehearsal session, buttons and controls) stay closer to a clean, high-contrast modern reading app. The brand should feel like a well-made library app wearing a theater costume, not a costume shop.

**Who it has to work for:** An actor returning to the stage later in life, first and foremost — which means every accessibility decision below is a brand decision, not an afterthought. It also has to work for community theater actors, drama students, and ESL learners, none of whom benefit from a design that prioritizes atmosphere over clarity.

---

## 2. Voice & tone

The Book Holder talks like backstage crew, not like a teacher grading homework. Supportive, plainspoken, a little dry — someone who's been in the wings for every performance and has your lines ready before you ask.

| Do | Don't |
|---|---|
| "You had act 2 solid last time — let's pick up where you left off." | "Great job! You're doing amazing!" |
| "Line's off. Want it again, or should I feed you the cue?" | "Incorrect. Please try again." |
| "Ford's speech, from the top." | "Beginning Exercise 4 of 12." |
| Plain contractions, active voice | Stiff, formal instruction-manual phrasing |

**Vocabulary to borrow** (real theater terms, used correctly): *the book*, *cue*, *line*, *prompt*, *run it*, *from the top*, *dry* (forgetting a line). These are free authenticity — use them in UI copy and in the AI's own voice.

**Clichés to avoid:** quill pens, comedy/tragedy masks, Globe Theatre silhouettes, "Ye Olde" spelling or blackletter type, mock-Elizabethan phrasing ("Hark!", "Prithee"). These read as costume-shop, not craft — a working actor will notice the difference immediately.

---

## 3. Naming glossary

Keep these consistent everywhere — copy, code, and conversation.

| Term | Meaning |
|---|---|
| **The Book Holder** | The product and the AI persona itself |
| **The Shelf** | Home/library screen — all available plays |
| **Prompt Book** | The personal tracking view: what's mastered, what needs work |
| **Favorite** | A play bookmarked to return to |
| **In progress** | A play with active rehearsal history |
| **Focus play** | The flagship, fully-built play (*The Merry Wives of Windsor* for MVP) |
| **Solid** | She had the beat — shown in coaching, never as a percentage |
| **Close** | She had the sense of it, not the words — the near-miss Shakespeare makes the norm |
| **Dry** | She didn't have it. Real theater term for forgetting a line (§2), which is exactly why it beats "missed" |

*Solid / close / dry* are product vocabulary, not just copy — they are the bands the coaching surfaces render and the values the code uses. Keep them identical in both. See `docs/coaching-plan.md` §3.

---

## 4. Color palette

Established direction: **warm parchment & candlelight.** Base tokens below now adopt exact values from `design.md` (the "Terracotta" system) — near-identical to what we'd already converged on, so this mostly formalizes rather than changes the mood.

| Role | Hex | Used for |
|---|---|---|
| **Ink** (primary text) | `#2B1D14` | Body text, headings — warm near-black, never pure black |
| **Parchment** (page background) | `#F3E8D8` | App background |
| **Surface** (card/component background) | `#FBF4E7` | Cards, elevated surfaces — a touch lighter than the page so components read as sitting on top of it, not flush with it |
| **On-primary** | `#FBF4E7` | Text/icons on a filled ink or accent background — formalizes the light-text-on-dark-fill pairing already used on primary buttons |

**Accent colors:**

| Role | Light tint | Mid | Dark (text-safe) | Used for |
|---|---|---|---|---|
| **Candlelight gold** | `#FAEEDA` | `#EF9F27` | `#854F0B` | Favorited state, featured/accent border, highlights |
| **Terracotta** | `#FAECE7` | `#C56A3C` | `#993C1D` | In-progress state, active rehearsal indicators |
| **Ash gray** (warm taupe) | `#F1EFE8` | `#8B6F5B` | `#444441` | Neutral/structural elements, not-started, locked/coming-soon |

**Resolved: intentional deviation from `design.md`'s single-accent rule.** `design.md` specifies terracotta as the only interactive color — *"the single-accent rule is load-bearing."* We're keeping our three-accent system instead: gold, terracotta, and ash-taupe each carry one fixed meaning everywhere in the product (favorited, in-progress/mastery, and neutral/locked respectively), and that redundant color-coding is load-bearing for us in a different way — it's part of how state stays readable without relying on text alone. Where there's no conflict, we did adopt `design.md`'s exact values: terracotta's mid stop is now its `tertiary` (`#C56A3C`, previously `#D85A30`), and ash gray's mid stop is now its `secondary` (`#8B6F5B`, previously `#B4B2A9`) — which also warms ash gray from a cool gray toward the taupe `design.md` uses for the same non-interactive role. Light/dark stops are retained from our existing ramp as close neighbors, not recalculated from the new mid — fine for now, worth revisiting for a precise ramp later.

**Rules:**
- Color never carries meaning alone — favorite is always gold **and** a star icon; in-progress is always terracotta **and** a progress bar or fraction of lines. Someone with color vision deficiency should be able to read every state.
- Text on a colored fill always uses that color's dark stop (or `On-primary` on a fully saturated fill) — never plain black or gray.
- Verify every text/background pairing against WCAG AA (4.5:1 for body text, 3:1 for large text/headings) with a contrast checker before shipping — don't eyeball it.

---

## 5. Typography

**Two-font system, now set from `design.md`:**
- **Display/voice serif** — *DM Serif Display*, for the wordmark, play titles, act/scene headers. `display` scale (4.5rem, weight 400, -0.015em tracking) for hero moments, `h1` scale (2.75rem, weight 400) for screen titles. Never used below 18px, and never for body copy or UI controls — small serif display type is where readability suffers most for an older reader.
- **UI/body sans** — *DM Sans*, for everything functional: buttons, labels, metadata, form fields, and (pending a decision, see open questions) possibly the script text itself. `body` scale: 1.05rem (~16.8px), line-height 1.7 — comfortably clears our 16px floor. `label` scale: `design.md` specifies 0.75rem (~12px) with 0.1em tracking; bumped to 0.8125rem (13px) here to stay within our accessibility floor for UI labels, tracking unchanged.

**Baseline sizing:** body text no smaller than 16px, UI labels no smaller than 13px. Every text size must remain legible and layout must not break when the user scales text up to 200%.

---

## 6. Iconography

Simple outline icons throughout (no filled/solid style, no illustration-heavy icon sets).

**Motifs to use:** bookmark ribbon (favorite), dog-eared corner or small progress ring (in progress), a lock (coming soon/locked plays), understated ink-underline for "mastered" lines.

**Motifs to avoid:** quill pens, tragedy/comedy masks, Globe Theatre silhouettes — overused Shakespeare shorthand that reads as generic rather than specific to this product.

---

## 7. Layout & component patterns

Established on the shelf mockup — reuse these patterns going forward:

- **Play card:** surface background, 16px corner radius (updated from an earlier 12px to match `design.md`'s `lg` radius token — apply 16px on cards going forward), thin hairline border. A solid color bar across the top (not a border-left accent) signals status — gold for favorited, terracotta for in-progress, ash gray for neutral/locked. This is the "book spine" without needing an illustrated shelf.
- **Featured/focus card:** same card, plus a 2px gold border. Reserve this treatment for one card at a time — it should mean something when it appears.
- **Status row:** every card's footer pairs an icon with text (never icon alone, never color alone) — e.g. a star plus "Saved for later," a progress bar plus "18 of 34 lines."
- **Filter tabs:** simple text tabs (All / Favorites / In progress), active tab distinguished by a filled background and stronger border, not just color.
- **Locked/coming-soon state:** reduced opacity (~60%), lock icon, "Coming soon" label — used to show scale (multiple plays) without requiring them to be fully built for the hackathon demo.

**Spacing & radius scale (from `design.md`):**

| Token | Value | Notes |
|---|---|---|
| Radius sm | 4px | Tight elements — badges, small chips |
| Radius md | 8px | Buttons |
| Radius lg | 16px | Cards (see Play card, above) |
| Spacing sm | 8px | Tight gaps — icon-to-label |
| Spacing md | 16px | Standard padding, gaps between related elements |
| Spacing lg | 32px | Section breaks |

**Component tokens (from `design.md`):**
- **Primary button:** filled with the accent's mid stop, `On-primary` text, `md` radius (8px), 12px/20px padding.
- **Card:** `Surface` background, `Ink` text, `lg` radius (16px), 24px padding.

---

## 8. Accessibility standards (non-negotiable)

These apply to every screen, not just the shelf:

- **Contrast:** 4.5:1 minimum for body text, 3:1 for large text/headings, checked against actual rendered colors — not assumed.
- **Tap targets:** minimum 44×44px for anything interactive.
- **Text scaling:** base sizes support scaling to 200% without breaking layout.
- **Redundant encoding:** color-coded states always paired with an icon or text label.
- **Focus states:** every interactive element has a visible focus indicator, not just a hover state.
- **Voice-first parity:** since Polly and Transcribe are core to the product, every key visual action should have a spoken/voice equivalent path — this is accessibility infrastructure the stack already provides, so it should be treated as a first-class interaction mode, not a fallback.

---

## 9. Rehearsal screen patterns

Established while designing the live rehearsal and scene wrap-up screens — extends the component patterns in §7.

**Mic/listening states — must never imply "ready" before it actually is:**

| State | Visual | Copy |
|---|---|---|
| Connecting | Gray, static mic icon + spinner | "Connecting mic…" |
| Listening | Gold, pulsing mic icon + live level bars | "Listening" |
| Processing | Gold mic icon replaced by spinner | "Got it, one moment…" |
| Captured | Brief check icon, then advances | No lingering copy — moves straight to the next line |
| Can't hear you | Ash gray icon + alert icon, paired | "Can't hear you — check your mic" |

Every state changes both icon *and* copy together — never a color or icon shift alone. Trust that the app is actually listening matters more on this screen than almost anywhere else in the product.

**Text-visible mode:** toggling "Show text" to "Hide text" reveals the active line the same way "Line?" does, so the "Line?" button disappears entirely once text is visible — there's nothing left for it to reveal. The state label (e.g. "Listening") stays put regardless of text visibility; the two are independent.

**Mic error recovery:** on "Can't hear you," the active card's border switches from gold to ash gray, not just the icon — the whole card reads as a different state, not a subtle color tweak. "Try again" sits alongside "Line?", since a dropped mic shouldn't also strand her without her line.

**Hidden-text / "call for line":** text hides only on manual toggle — never auto-hides based on mastery, at least at MVP. Tapping "Line?" reveals the line's text immediately *and* shows a separate "Read line aloud" button. Text and audio are two distinct, explicit affordances, not bundled into one action — this is the accessibility default. An auto-read-on-peek setting is a reasonable v2 addition, not MVP.

**Feedback timing — revised August 2026, see `docs/coaching-plan.md` §4.** This rule previously read "no interruption mid-scene; mismatches are captured silently and only surface in the scene wrap-up." Coaching now appears *during* the scene, per block. The intent behind the original rule is unchanged and still binding — what changed is the assumption that honoring it meant saying nothing until the scene ended.

The standard is **non-interruptive, not invisible**:

- Nothing blocks. Advancing to the next block never waits on a score.
- Nothing demands a response. She can ignore every annotation and the rehearsal is identical.
- No sound, and no motion that pulls the eye — this is not a notification.
- The annotation is clickable, and opening it pauses playback to show the block's notes. Pausing is correct here *because* it is opt-in: she chose to stop and read.

Never "wrong" or "incorrect," unchanged from the original rule and from §2.

**Per-block coaching placement:** under the block, not in a side gutter. A third column narrows the script, needs its own responsive answer, and fights the 200% text-scaling requirement in §8. The annotation slot is **reserved from the start** — every one of her blocks renders a fixed-height empty area that fills in when the score lands, so nothing reflows. Text moving under an actor mid-scene reads as a bug. Scores may arrive a block behind; an unscored block shows a quiet pending state, never a hole.

**Scoring vocabulary — *solid* / *close* / *dry*.** See §3. Never a percentage: a per-block "72%" is precisely the homework-grading register §2 rules out. `confidence_score` stays continuous underneath and drives everything; it is simply not shown as a grade.

**Scene wrap-up:** every block scored, plus a summary note for the whole scene and a fraction — "31 of 34 beats solid." A fraction rather than a percentage, consistent with §10's "the fraction is the real signal." Flagged lines still render as bordered list rows, not cards — a dense, repeatable list, where card treatment would be too heavy. Each row pairs the line text with a "Replay" button tied to the recorded take.

**Multi-speaker lines:** when a line is shared by more than one character, show it as secondary text under the character name (e.g. "with Shallow, Slender") — context, not an interruption to the line itself.

**Stage directions:** rendered inline between speech blocks, centered, italic, muted color — never as a full card or a modal interruption.

**Role selection:** one role per play, set once, the first time she opens it — not a per-session choice at MVP. Characters render as a bordered list (not cards, per the dense-list rule), selection marked with a gold checkmark, single gold-filled primary button to confirm ("Start rehearsing as [Name]"). Switching roles mid-play is out of scope for MVP; noted below for later.

**Scene picker:** shown every time she reopens a play she's already rehearsing (role already confirmed, shown as a small identity tag at the top). A gold-bordered "Continue" card defaults to wherever she last stopped — same accent treatment as the featured play card in §7. Below it, the full act/scene list renders as bordered rows grouped under uppercase act labels, each row pairing a short scene description with a mastery bar plus fraction (e.g. "11 of 35"). The current scene is also highlighted within the list itself, not only in the continue card, so scrolling past it doesn't lose her place. Bar length reflects percent mastered, but the fraction is the real signal — a short scene fully mastered and a long one fully mastered should read with equal visual confidence, not equal bar length.

---

## 10. Prompt Book patterns

The reflective, whole-play counterpart to the scene picker in §9 — where "what's mastered, what needs work" stops being an ambient signal and becomes the point of the screen.

**Overall mastery stat:** a simple fraction ("71 of 96 lines mastered") with a terracotta progress bar — same color as every other mastery indicator in the product, kept consistent rather than introducing a separate "achievement" color.

**Needs another look:** a bordered list (dense-list rule, per §7) pulled from across the whole play, not scoped to one scene — that's the actual value over the scene picker. Sorted by cumulative mistake count, highest first. Each row shows act/scene context, the line itself, a "last practiced" timestamp for context (not the sort key), and a small terracotta count badge — same terracotta family as the mastery bars, so a high mistake count reads as information, not a warning. The whole row is tappable and launches a focused practice session on just that line, with a chevron signaling it's navigable, not just a reference list.

---

## 11. Open questions for the next iteration

- Session history log — deferred from the Prompt Book at MVP to keep the screen focused on needs-work only; worth reconsidering once there's real session data to show.
- Switching roles within a play — MVP is one role per play, set once. Letting her read a second character (e.g. to practice scenes without a partner) is a natural post-MVP extension, not needed for the hackathon build.
- ~~Severity distinction for flagged lines~~ — **answered by the three bands in §3.** A near-miss now reads as *close* and a blank as *dry*, so they no longer look identical. What remains open is not the distinction but where the two cuts fall (`OPEN_ITEMS.md` §1a), which needs real transcripts rather than a design decision.
- Auto-read vs. manual "Read line aloud" as a configurable setting — post-MVP; the MVP always shows both text and a manual read button.
- Exact copy/behavior for mic permission failures (denied at the OS level vs. a dropped connection mid-session) — needs a real pass once the AWS Transcribe integration is wired up.
- Should the script text itself use the display serif or the UI sans? Readability under time pressure argues for sans; character argues for serif. Worth testing both.
- Wordmark/logo mark — not yet designed. A small ribbon-bookmark icon could double as a favicon/app icon at MVP stage rather than a full illustrated mark.
- Low-light/evening rehearsal mode — worth considering given the "candlelight" mood, separate from a generic dark mode.
