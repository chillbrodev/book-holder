import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getPlay, getSceneDialogue, getSelectedRole, getSingleLineDialogue, setLastScene } from '../data/client'
import { getBlockAudio } from '../data/pollyClient'
import { isPlaybackBlocked, playUrl, unlockPlayback } from '../utils/audioPlayback'
import type { PlaybackSession } from '../utils/audioPlayback'
import { completeSession, startSession } from '../data/sessionClient'
import { recordSessionSave } from '../data/pendingSessionSave'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../auth/useAuth'
import { useMicCapture } from '../hooks/useMicCapture'
import { DialogueLine } from '../components/rehearsal/DialogueLine'
import { StageDirection } from '../components/rehearsal/StageDirection'
import { MicStateIndicator } from '../components/rehearsal/MicStateIndicator'
import { CaptureDebugInfo } from '../components/rehearsal/CaptureDebugInfo'
import { HeardSoFar } from '../components/rehearsal/HeardSoFar'
import { BlockCoachingNote } from '../components/rehearsal/BlockCoachingNote'
import type { BlockScored } from '../hooks/useMicCapture'
import { Button } from '../components/core/Button'
import { Icon } from '../components/core/Icon'
import { ToggleButton } from '../components/core/ToggleButton'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { toDisplayName } from '../utils/format'
import styles from './RehearsalPage.module.css'

const AUTO_ADVANCE_DELAY_MS = 650

/**
 * How long her finished speech stays on screen once the coach has answered.
 *
 * Long enough to register that the pills arrived and read a short note, short
 * enough that it reads as a beat between speeches rather than a wait.
 */
const SCORE_SEEN_MS = 900

/**
 * The longest the scene will hold for a score that hasn't come.
 *
 * Measured coaching latency is 0.8-1.3s, so this usually expires unused — the
 * score lands first and `SCORE_SEEN_MS` takes over. It exists for the cases
 * where nothing is coming at all: Bedrock unreachable, the socket lost, a guest
 * whose connection dropped. The scene must never stall on feedback.
 */
const SCORE_WAIT_CAP_MS = 1500

/**
 * How long a speech worth looking at stays up before the scene moves on itself.
 *
 * The backstop behind the Continue button, not the expected path — she taps
 * when she has read it. It exists so that putting the phone down mid-scene
 * doesn't leave the rehearsal parked forever, and it is generous because being
 * hurried through a note is the thing this whole mechanism exists to prevent.
 */
const AUTO_CONTINUE_MS = 6000

/**
 * Whether a scored speech is worth stopping for.
 *
 * The split that keeps the Continue button from becoming the per-line
 * confirmation tap this page deliberately removed once — "pure friction… a
 * small piece of admin" is the comment on the effect below, and it was right.
 * A speech she had needs no acknowledgement: the pills going by *are* the
 * acknowledgement, and there is nothing to read.
 *
 * So the scene stops only when there is something to look at — a beat that
 * wasn't solid, or a note. Which is roughly when a person holding the book
 * would stop you, and not otherwise.
 *
 * Notes are trusted here because the server now drops ungrounded ones
 * (`coaching/service.ts`). Before that filter a note meant almost nothing —
 * Nova would emit "All beats are dry" — and stopping the scene on one would
 * have been stopping it for filler.
 */
function worthAPause(score: BlockScored): boolean {
  return score.note.length > 0 || score.beats.some((beat) => beat.band !== 'solid')
}
const AUTO_SCROLL_STORAGE_KEY = 'bh:autoScroll'

export function RehearsalPage() {
  const { playId = '', act = '', scene = '' } = useParams()
  const [searchParams] = useSearchParams()
  const lineId = searchParams.get('line')
  const backTo = searchParams.get('back')
  const navigate = useNavigate()
  // Only a signed-in user has anywhere to save a session to (sessionClient.ts).
  const { user } = useAuth()

  const { data: dialogue, loading, error } = useAsync(
    () => (lineId ? getSingleLineDialogue(playId, lineId) : getSceneDialogue(playId, act, scene)),
    [playId, act, scene, lineId],
  )
  const { data: play } = useAsync(() => getPlay(playId), [playId])
  const { data: role } = useAsync(() => getSelectedRole(playId), [playId])

  const [cursor, setCursor] = useState(0)
  const [showYourLines, setShowYourLines] = useState(false)
  const [showOtherLines, setShowOtherLines] = useState(true)
  const [readingPaused, setReadingPaused] = useState(false)
  // How many beats she's called for, counted *from wherever the mic thinks she
  // is* — not from the top of the speech. 0 = nothing revealed; each "Line?"
  // hands over one more thought, never the whole speech.
  const [beatsRevealed, setBeatsRevealed] = useState(0)
  // Which beat the reveal starts from, pinned at the moment she asks. Without
  // pinning it, the revealed text would slide forward under her as the mic
  // cursor moves — she asked to see *this* thought, not a rolling window.
  const [revealAnchor, setRevealAnchor] = useState<number | null>(null)
  // Which block is currently being read aloud to her, if any — so the button can
  // say so and can't be triggered twice over itself.
  const [readingAloudBlockId, setReadingAloudBlockId] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // Persisted across sessions, not just this scene — someone who turns it
  // off wants it off everywhere, not re-prompted every rehearsal.
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== 'off')
  // Phone only: whether the play title and the change-scene/role links are
  // showing. Closed by default because on a 390px screen that block cost ~90px
  // of a permanently pinned header to tell her the name of the play she just
  // chose and offer two links she needs about once a rehearsal. Above 600px the
  // disclosure button is display:none and the meta is always shown, so this
  // state exists but governs nothing — the desktop header is unchanged.
  const [sceneMetaOpen, setSceneMetaOpen] = useState(false)
  // The browser refused to play a cue, so the reading is holding rather than
  // running the scene down in silence. Cleared by the prompt below, whose tap
  // is what makes playback possible again.
  const [audioBlocked, setAudioBlocked] = useState(false)
  // Bumped to re-run the playback effect for the current line after an unlock;
  // `cursor` hasn't moved, so without it the effect has no reason to retry.
  const [playbackAttempt, setPlaybackAttempt] = useState(0)

  useEffect(() => {
    localStorage.setItem(AUTO_SCROLL_STORAGE_KEY, autoScroll ? 'on' : 'off')
  }, [autoScroll])

  // Records her place for the play page's resume card. Not written for a
  // single-line practice run (`?line=`) — that's a drill launched from
  // somewhere else, not a place in the play to come back to.
  useEffect(() => {
    if (!lineId && act && scene) setLastScene(playId, act, scene)
  }, [playId, act, scene, lineId])

  useEffect(() => {
    setCursor(0)
    setDone(false)
  }, [dialogue])

  const activeEntry = dialogue?.[cursor]
  // Keyed on the block, not a beat — the mic stays open across a whole speech,
  // so resetting its state at every beat boundary would interrupt exactly the
  // continuous delivery beats exist to avoid scoring away.
  const activeLineKey = activeEntry?.type === 'speech' ? activeEntry.blockId : `entry-${cursor}`

  // The mic opens only for her own blocks. Polly voices everybody else, and the
  // two never contend — so passing undefined here is what keeps a live mic (and
  // a billing Transcribe stream) off every other character's speech.
  const activeUserBlockId =
    activeEntry?.type === 'speech' && activeEntry.isUserLine ? activeEntry.blockId : undefined

  /**
   * The open session this rehearsal writes into, once there is one.
   *
   * `undefined` for a guest and for a single-beat drill, and briefly undefined
   * at the very start of every rehearsal while the request is in flight. All
   * three are the same case as far as this page is concerned: coaching is
   * identical, only the memory differs (docs/coaching-plan.md §7).
   */
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  /** The session couldn't be opened. Distinct from "guest" in cause and
   * identical in consequence, which is why they share one message below. */
  const [sessionFailed, setSessionFailed] = useState(false)
  /** Dismissed for this rehearsal. Not persisted — it is a statement of fact
   * about *this* run, and a guest starting a new scene should be told again. */
  const [noticeDismissed, setNoticeDismissed] = useState(false)

  /**
   * Every block's score, keyed by blockId.
   *
   * Filed by callback rather than read off the live block, because a score
   * arrives about a second after `complete` and the page has usually advanced
   * by then — the block it belongs to is no longer the active one. The event
   * carries its own `blockId` for exactly this reason.
   */
  const [coachingByBlock, setCoachingByBlock] = useState<Map<string, BlockScored>>(new Map())
  const fileScore = useCallback((scored: BlockScored) => {
    setCoachingByBlock((previous) => new Map(previous).set(scored.blockId, scored))
  }, [])

  /** When the current block finished capturing, so the wait for its score can be
   * capped from that moment rather than from whenever the effect last re-ran. */
  const capturedAtRef = useRef<number | null>(null)

  const { micState, tapMic, retry, beatIndex, beatsCompleted, beatCount, stalled, transcript, heard, setMuted } =
    useMicCapture(activeUserBlockId, role?.id, sessionId, fileScore)

  // Stamped on the transition into `captured`, cleared on the way out, so the
  // cap above measures the wait for *this* block's score.
  useEffect(() => {
    capturedAtRef.current = micState === 'captured' ? Date.now() : null
  }, [micState, activeUserBlockId])

  /** The scene is holding on this speech because there is something on it worth
   * reading — which is also the only condition under which Continue appears. */
  const activeScore = activeUserBlockId ? coachingByBlock.get(activeUserBlockId) : undefined
  const holdingForScore = !!activeScore && worthAPause(activeScore)

  // Every beat she's attempted this scene, keyed by lineId so a block re-entered
  // (a retry, or a re-render delivering the same `complete`) overwrites rather
  // than duplicates. A ref, not state: nothing renders from it, and appending to
  // state here would re-run the effects that drive playback and the mic.
  const attemptsRef = useRef(new Map<string, string>())
  // When this scene started, for session_history.duration_seconds.
  const startedAtRef = useRef(Date.now())

  useEffect(() => {
    attemptsRef.current = new Map()
    startedAtRef.current = Date.now()
    setCoachingByBlock(new Map())
  }, [playId, act, scene, lineId])

  /**
   * Open the session before she says anything.
   *
   * `coaching-plan.md` §6 moved this from the end of the scene to the start,
   * because per-block writes need somewhere to write while the scene is still
   * running. The consequence it also fixes: abandoning a scene used to lose the
   * entire run, and now keeps every block she actually got through.
   *
   * Skipped for a single-beat drill (`?line=`) — that is a practice run rather
   * than a rehearsal of a scene — and for guests, who have no user row to hang
   * a session on.
   *
   * A failure here is deliberately not surfaced. She can still rehearse, still
   * be listened to, and still be coached; the run simply isn't remembered,
   * which is the guest experience and not an error worth a dialog mid-scene.
   */
  useEffect(() => {
    if (lineId || !user || !play || !role) return
    let cancelled = false
    startSession({ playId: play.id, act, scene, characterId: role.id })
      .then((started) => {
        if (!cancelled) setSessionId(started.sessionId)
      })
      .catch((err) => {
        // Told, not just logged — see `notRemembered` below. She can carry on
        // either way, but she should not find out at the wrap-up that a scene
        // she just ran was never written down.
        console.warn('This rehearsal will not be remembered:', err)
        if (!cancelled) setSessionFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ids, deliberately, not the objects: `play`, `role` and `user` are re-derived every render, and depending on them would open a fresh session on each one
  }, [play?.id, act, scene, role?.id, user?.id, lineId])

  // The per-beat split arrives with the capture's `complete` event. This is the
  // point where what she said stops being ephemeral — until now it was computed,
  // sent to the browser, and dropped on the next block.
  useEffect(() => {
    for (const beat of heard) {
      attemptsRef.current.set(beat.lineId, beat.heard)
    }
  }, [heard])

  useEffect(() => {
    setBeatsRevealed(0)
    setRevealAnchor(null)
  }, [activeLineKey])

  const activeLineRef = useRef<HTMLDivElement>(null)

  // Re-runs on cursor changes (a new line becomes active) and on anything
  // that grows the active card after the fact (text reveal, mic-state
  // buttons) — otherwise those can push the mic controls below the fold
  // with no follow-up scroll. `.lines` carries generous bottom padding
  // (see RehearsalPage.module.css) so 'end' has room to settle instead of
  // snapping against the viewport edge. Also fires right when autoScroll
  // flips back on, so resuming catches up to wherever the rehearsal is
  // instead of waiting for the next line.
  useEffect(() => {
    if (!autoScroll) return
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [cursor, showYourLines, showOtherLines, beatsRevealed, micState, autoScroll])

  // With auto-scroll off, the rehearsal keeps advancing while the view stays
  // put — so the live line silently ends up below the fold with nothing on
  // screen saying so. Watching the active line directly (rather than assuming
  // it's offscreen) means the prompt only appears when it actually is.
  const [activeLineOffscreen, setActiveLineOffscreen] = useState(false)

  useEffect(() => {
    const el = activeLineRef.current
    if (!el || autoScroll) {
      setActiveLineOffscreen(false)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setActiveLineOffscreen(!entry.isIntersecting), {
      threshold: 0.4,
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [cursor, dialogue, autoScroll])

  function jumpToActiveLine() {
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  function advance() {
    if (!dialogue) return
    if (cursor + 1 >= dialogue.length) {
      finishRehearsal()
    } else {
      setCursor((c) => c + 1)
    }
  }

  /**
   * Writes the rehearsal, then moves to the wrap-up.
   *
   * Fire-and-forget on purpose — the navigation does not wait on the write, and a
   * failed write does not trap her on the rehearsal screen. She has finished the
   * scene either way, and the wrap-up is where she's going; a save that failed is
   * worth telling her about there, not worth blocking her here.
   *
   * Skipped entirely for a single-beat drill (`?line=`), which is a practice run
   * rather than a rehearsal of a scene, and for guests, who have no user row to
   * hang a session on.
   */
  function submitSession() {
    // No session means a guest, a single-beat drill, or a rehearsal whose
    // session never opened. Nothing to close in any of those cases — and
    // nothing lost either, because there was never anything being written.
    if (lineId || !user || !play || !sessionId) return

    // Her beats are already stored. Each block was written as it finished, over
    // the capture socket, which is what makes an abandoned scene keep the part
    // she did rather than losing all of it. This call only says the run has
    // stopped; the server decides whether it *counted* as finished, by checking
    // that every block she meant to run has all its beats scored.
    const result = completeSession(
      sessionId,
      Math.round((Date.now() - startedAtRef.current) / 1000),
    ).then(() => ({ sessionId }))

    // Handed to the wrap-up so it reads back *this* run rather than racing the
    // write and finding the previous one. Much less of a race than it used to
    // be — the beats are already down — but the closing call still has to land
    // before the summary is read, or the duration is missing.
    recordSessionSave({ playId: play.id, act, scene, result })

    void result.catch((err) => {
      // Not surfaced as a blocking error: she has finished the scene and is on
      // her way to the wrap-up, which is where a failure is worth mentioning.
      // Note what is *not* lost here any more — the rehearsal itself is already
      // stored, so this failing costs the duration and the completed_at flag,
      // not the run.
      console.error('Could not close this rehearsal:', err)
    })
  }

  function finishRehearsal() {
    submitSession()
    if (lineId) {
      setDone(true)
      return
    }
    navigate(`/play/${playId}/wrap-up/${act}/${scene}`)
  }

  // Stage directions, and any other-character speech line missing a
  // lineId/speakerId (defensive), still advance on a fixed delay. Real
  // other-character speech is handled by the audio effect below instead —
  // guarded out here so the two effects never both schedule an advance for
  // the same entry.
  useEffect(() => {
    if (!dialogue || done || readingPaused) return
    const entry = dialogue[cursor]
    if (!entry) return
    if (entry.type === 'speech' && entry.isUserLine) return
    if (entry.type === 'speech' && entry.blockId && entry.speakerId) return

    const timer = setTimeout(() => advance(), AUTO_ADVANCE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance()/finishRehearsal() close over cursor/dialogue, re-derived every render
  }, [cursor, dialogue, done, readingPaused])

  // Other characters' blocks: fetch real Polly audio and advance when it
  // finishes playing, rather than a fixed delay. One request per block, so a
  // speech plays as one continuous delivery instead of a run of clips. Falls back to the timer if
  // Polly errors — graceful degradation per docs/BE_PLAN.md §5, so a
  // synthesis failure never blocks the rehearsal.
  // Pausing tears this effect down, which stops the audio mid-line; resuming
  // re-runs it and replays that line from its start rather than resuming
  // mid-word. For a rehearsal cue that's the useful behaviour — you paused
  // because you missed it.
  useEffect(() => {
    if (!dialogue || done || readingPaused) return
    const entry = dialogue[cursor]
    if (!entry || entry.type !== 'speech' || entry.isUserLine) return
    if (!entry.blockId || !entry.speakerId) return

    let cancelled = false
    let session: PlaybackSession | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    getBlockAudio(entry.blockId, entry.speakerId)
      .then(({ audioUrl }) => {
        if (cancelled) return
        session = playUrl(audioUrl, {
          onEnded: () => {
            if (!cancelled) advance()
          },
          onError: () => {
            if (!cancelled) advance()
          },
        })
        return session.started
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // The two failures here want opposite responses, and collapsing them
        // into one `advance()` is what made this unusable on iOS. A refusal to
        // play is not a missing cue to skip past — nothing is wrong with the
        // audio, and skipping runs the whole scene down in silence 650ms at a
        // time until it reaches her next line. So it stops and asks, and the
        // tap on that prompt is the gesture that buys back playback.
        if (isPlaybackBlocked(error)) {
          setAudioBlocked(true)
          return
        }
        // A genuinely broken cue — synthesis failed, the signed URL 403'd.
        // Keep the rehearsal moving; that is what this delay is for.
        fallbackTimer = setTimeout(() => advance(), AUTO_ADVANCE_DELAY_MS)
      })

    return () => {
      cancelled = true
      session?.cancel()
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance() closes over cursor/dialogue, re-derived every render
  }, [cursor, dialogue, done, readingPaused, playbackAttempt])

  /**
   * Her speech is captured, so move on — but not before she has seen how it
   * went.
   *
   * **This reverses `coaching-plan.md` §4's "advancing to the next block never
   * waits on a score".** That rule was right about the danger and wrong about
   * the arithmetic. It assumed the annotation could land late and still be read,
   * because she would be listening to the next character and could glance back.
   * With auto-scroll on there is nothing to glance at: the score arrives ~1s
   * after `complete`, the page advanced 500ms after it, and the pills rendered
   * under a speech that had already left the screen. Non-interruptive was
   * satisfied; the intent behind it wasn't. Coaching she never sees is coaching
   * that isn't happening.
   *
   * So the scene waits for the score, and then for a moment longer — capped, so
   * it can never stall on feedback that isn't coming. The delay is smaller than
   * it sounds: advancing is what triggers `getBlockAudio` for the next
   * character, so part of this overlaps a gap that already existed.
   */
  useEffect(() => {
    // `activeUserBlockId` is in the condition as well as the state: without it, a
    // `captured` left over from a previous line could advance the scene while
    // somebody else is speaking.
    if (!activeUserBlockId || micState !== 'captured' || done || readingPaused) return

    const score = coachingByBlock.get(activeUserBlockId)
    // Measured from when the capture completed, not from when this effect last
    // ran. The effect re-runs when the score lands, and a cap restarted from
    // there would be a second full wait rather than the remainder of the first.
    const waitedFor = capturedAtRef.current === null ? 0 : Date.now() - capturedAtRef.current
    const delay = !score
      ? Math.max(0, SCORE_WAIT_CAP_MS - waitedFor)
      : worthAPause(score)
      ? AUTO_CONTINUE_MS
      : SCORE_SEEN_MS

    const timer = setTimeout(() => advance(), delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance() closes over cursor/dialogue, re-derived every render
  }, [activeUserBlockId, micState, done, readingPaused, coachingByBlock])

  /**
   * Plays her own line back to her.
   *
   * Answers OPEN_ITEMS §3's open question — whether she can ask to hear her own
   * lines — in the affirmative, but only on request. The scene reading still
   * skips her lines, because voicing them unasked would rehearse the speech
   * *for* her. Called for after "Line?", when she's already admitted she doesn't
   * have it and reading it hasn't been enough.
   *
   * Mutes the mic for the duration. Polly out of the same laptop the mic is on
   * gets transcribed as her words otherwise — barge-in (docs/capture-plan.md §8),
   * and self-inflicted here rather than incidental. Her own block is in the warm
   * cache like every other, so this is a signed-URL lookup, not a paid synthesis.
   */
  async function readLineAloud(blockId: string, speakerId: string) {
    if (readingAloudBlockId) return
    // Synchronous, before the first await, while this click's activation is
    // still live. It is nearly always a no-op by now — the first tap anywhere
    // in the app already unlocked playback (AppLayout) — but this is the one
    // path with a real gesture in hand at the moment of playing, so it may as
    // well be the belt to that braces. After the await below the activation is
    // gone, which is exactly how the autoplay bug arose in the first place.
    unlockPlayback()
    setReadingAloudBlockId(blockId)
    setMuted(true)
    try {
      const { audioUrl } = await getBlockAudio(blockId, speakerId)
      await new Promise<void>((resolve) => {
        const session = playUrl(audioUrl, { onEnded: resolve, onError: resolve })
        // Resolves on refusal too: she asked for the line, and leaving the
        // button stuck on "Reading…" with the mic muted would be a worse
        // failure than simply not hearing it.
        void session.started.catch(() => resolve())
      })
    } finally {
      setMuted(false)
      setReadingAloudBlockId(null)
    }
  }

  const backHref = backTo ?? `/play/${playId}`
  const backLabel = backTo?.includes('wrap-up')
    ? 'Back to wrap-up'
    : backTo?.includes('prompt-book')
      ? 'Back to Prompt Book'
      : `Back to ${play?.title ?? 'the play'}`

  if (loading || error || !dialogue) {
    return <AsyncStatus loading={loading} error={error} />
  }

  if (done) {
    return (
      <div className={styles.wrap}>
        <div className="bh-h1">Nice — that's practiced.</div>
        <p className={styles.doneCopy}>That line's back in the mix for next time.</p>
        <Link to={backHref}>
          <Button variant="secondary">{backLabel}</Button>
        </Link>
      </div>
    )
  }

  const visible = dialogue?.slice(0, cursor + 1) ?? []

  return (
    <div className={styles.wrap}>
      {/* data-meta-open governs the phone layout only — it gates the play title
          and the two change links, which above 600px are shown unconditionally.
          One flag on the header rather than a prop on each, because they hide
          and reveal together and are not adjacent in the DOM. */}
      <header className={styles.header} data-meta-open={sceneMetaOpen || undefined}>
        {play && <h1 className={`bh-display ${styles.playTitle}`}>{play.title}</h1>}
        <div className={styles.sceneLine}>
          <span className={styles.sceneLabel}>
            Act {act}, Scene {scene}
            {role && <span className={styles.sceneRole}> · as {toDisplayName(role.name)}</span>}
          </span>
          {/* Replaces the old "back to the play" link — same destination, but
              named for what she'd actually be going there to do. */}
          <span className={styles.sceneActions}>
            <Link to={`/play/${playId}?step=scene`} className={styles.changeLink}>
              Change scene
            </Link>
            <Link to={`/play/${playId}?step=role`} className={styles.changeLink}>
              Change role
            </Link>
          </span>
          {/* display:none above 600px — on desktop there is nothing to disclose,
              since everything it would reveal is already on screen. */}
          <button
            type="button"
            className={styles.metaDisclosure}
            onClick={() => setSceneMetaOpen((v) => !v)}
            aria-expanded={sceneMetaOpen}
            aria-label={sceneMetaOpen ? 'Hide play details' : 'Show play details'}
          >
            <Icon name={sceneMetaOpen ? 'chevron-up' : 'chevron-down'} size={20} />
          </button>
        </div>
        {/* Only ever shown when the browser has actually refused — not a
            standing "enable sound" banner. The tap is the point: it is a real
            user gesture, so unlocking inside it is what makes the retry work. */}
        {audioBlocked && (
          <button
            type="button"
            className={styles.audioBlocked}
            onClick={() => {
              unlockPlayback()
              setAudioBlocked(false)
              setPlaybackAttempt((n) => n + 1)
            }}
          >
            <Icon name="play" size={18} />
            Tap to hear the other parts
          </button>
        )}
        {/* Shown when this run isn't being written down: a guest, or a session
            that failed to open. Different causes, same consequence, so one
            message covers both rather than making her distinguish them.
            Deliberately not shown for a single-beat drill, which was never
            going to be saved and where saying so would be noise.

            Nothing blocks and nothing is demanded — the same rule as the
            annotation slot (§4). She can dismiss it and rehearse exactly as
            before; the only thing missing is the memory, which is precisely
            what "Save Progress" has always been offering. */}
        {!lineId && !sessionId && (!user || sessionFailed) && !noticeDismissed && (
          <div className={styles.notRemembered}>
            <span>
              {user
                ? "This run isn't being saved — something went wrong opening it."
                : "This run won't be saved. Sign in and the Book Holder remembers how it went."}
            </span>
            <button
              type="button"
              className={styles.notRememberedDismiss}
              onClick={() => setNoticeDismissed(true)}
              aria-label="Dismiss"
            >
              Got it
            </button>
          </div>
        )}
        <div className={styles.controls}>
          <ToggleButton
            on={!readingPaused}
            label="Scene reading"
            shortLabel="Reading"
            onStateLabel="Playing"
            offStateLabel="Paused"
            onIcon="pause"
            offIcon="play"
            onClick={() => setReadingPaused((v) => !v)}
          />
          <ToggleButton
            on={autoScroll}
            label="Auto-scroll"
            shortLabel="Auto"
            onStateLabel="On"
            offStateLabel="Off"
            onIcon="scroll-down"
            offIcon="scroll-off"
            onClick={() => setAutoScroll((v) => !v)}
          />
          <ToggleButton
            on={showYourLines}
            label="Your lines"
            shortLabel="Yours"
            onStateLabel="Shown"
            offStateLabel="Hidden"
            onIcon="eye"
            offIcon="eye-off"
            onClick={() => {
              setShowYourLines((v) => !v)
              setBeatsRevealed(0)
            }}
          />
          <ToggleButton
            on={showOtherLines}
            label="Other lines"
            shortLabel="Others"
            onStateLabel="Shown"
            offStateLabel="Hidden"
            onIcon="eye"
            offIcon="eye-off"
            onClick={() => setShowOtherLines((v) => !v)}
          />
        </div>
      </header>

      <div className={styles.lines}>
        {visible.map((entry, i) => {
          const active = i === cursor && entry.type === 'speech' && entry.isUserLine
          const ref = i === cursor ? activeLineRef : undefined
          if (entry.type === 'stage') {
            // Grouped with the other characters' text rather than kept always
            // on: with both text toggles off the screen should actually be
            // clear, and a stage direction is someone else's cue, not her line.
            return showOtherLines ? (
              <div key={`stage-${i}`} ref={ref} className={styles.lineAnchor}>
                <StageDirection>{entry.text}</StageDirection>
              </div>
            ) : (
              <div key={`stage-${i}`} ref={ref} className={styles.lineAnchor} />
            )
          }
          if (!active) {
            // Speaker name stays even when the text is hidden — she still needs
            // to follow who's talking to know when her cue lands.
            //
            // Her own blocks keep their annotation after the mic has moved on,
            // so scrolling back shows how a speech went rather than a blank.
            // Other characters' blocks get nothing: they were never scored, and
            // a reserved slot under every line of the scene would be a lot of
            // empty space to buy nothing.
            const scoredBefore = entry.isUserLine ? coachingByBlock.get(entry.blockId) : undefined
            return (
              <div key={entry.blockId} ref={ref} className={styles.lineAnchor}>
                <DialogueLine block={entry} overrideText={showOtherLines ? undefined : ''}>
                  {scoredBefore && (
                    <BlockCoachingNote coaching={scoredBefore} beatCount={entry.beats.length} />
                  )}
                </DialogueLine>
              </div>
            )
          }
          // Her own block. Shown outright only if "Your lines" is on; otherwise
          // held back, and each "Line?" hands over one more beat — one thought
          // at a time, so a sixteen-beat speech isn't given away in one tap.
          // "Line?" hands over the beat she's actually stuck on. The mic keeps a
          // beat cursor across the block (docs/OPEN_ITEMS.md §1b), so this starts
          // where she dried up rather than at the top of a speech she'd already
          // half-delivered.
          const revealFrom = revealAnchor ?? beatIndex
          const revealedBeats = entry.beats.slice(revealFrom, revealFrom + beatsRevealed)
          const nextBeat = entry.beats[revealFrom + beatsRevealed]
          return (
            <div key={entry.blockId} ref={ref} className={styles.lineAnchor}>
              <DialogueLine
                block={entry}
                overrideText={
                  showYourLines
                    ? undefined
                    : beatsRevealed === 0
                      ? "Line's held back — call for it below if you need it."
                      : ''
                }
                promptedBeat={showYourLines ? undefined : revealedBeats.map((b) => b.text).join(' ')}
                active
                micError={micState === 'cantHear'}
              >
                <div className={styles.micRow}>
                  <MicStateIndicator
                    state={micState}
                    onTap={tapMic}
                    beatsCompleted={beatsCompleted}
                    beatCount={beatCount}
                    stalled={stalled}
                    holding={holdingForScore}
                  />
                </div>
                {/* Her words in production; the cursor/mic diagnostics only in
                    dev. Both read the same transcript — the difference is who
                    each is for. */}
                <HeardSoFar micState={micState} transcript={transcript} />
                <CaptureDebugInfo
                  micState={micState}
                  beatIndex={beatIndex}
                  beatCount={entry.beats.length}
                  transcript={transcript}
                />
                {/* Directly beneath the words it is judging, and beneath the
                    live transcript that produced them — HeardSoFar shows what
                    was heard, this shows what was made of it. Reserved from the
                    moment the block becomes active, so the score landing a
                    second later moves nothing. */}
                <BlockCoachingNote
                  coaching={coachingByBlock.get(entry.blockId)}
                  beatCount={entry.beats.length}
                />
                <div className={styles.actions}>
                  {/* Shown only while the scene is holding on this speech, which
                      is only when there was something to look at. On a clean
                      speech it never appears and nothing is asked of her — that
                      split is what keeps this from being the per-line
                      confirmation tap removed below.

                      It skips the remaining wait rather than causing the
                      advance: the scene was going to move on by itself either
                      way, so tapping it is never the difference between
                      rehearsing and not. */}
                  {micState === 'captured' && holdingForScore && (
                    <Button variant="primary" onClick={() => advance()}>
                      Continue
                    </Button>
                  )}
                  {micState === 'cantHear' && (
                    <Button variant="secondary" onClick={retry}>
                      Try again
                    </Button>
                  )}
                  {/* The way out when the app can't tell she's finished — a real
                      button, because the tappable mic dial reads as a status
                      light and nobody finds it. Promoted to primary once she's
                      gone quiet mid-thought, when it's the likeliest thing she
                      wants. */}
                  {micState === 'listening' && (
                    <Button variant={stalled ? 'primary' : 'secondary'} onClick={tapMic}>
                      I've said it
                    </Button>
                  )}
                  {!showYourLines && micState !== 'captured' && nextBeat && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRevealAnchor((anchor) => anchor ?? beatIndex)
                        setBeatsRevealed((n) => n + 1)
                      }}
                    >
                      {beatsRevealed === 0 ? 'Line?' : 'Next bit?'}
                    </Button>
                  )}
                  {beatsRevealed > 0 && !showYourLines && entry.speakerId && (
                    <Button
                      variant="secondary"
                      onClick={() => void readLineAloud(entry.blockId, entry.speakerId!)}
                      disabled={readingAloudBlockId !== null}
                    >
                      {readingAloudBlockId === entry.blockId ? 'Reading…' : 'Read line aloud'}
                    </Button>
                  )}
                </div>
              </DialogueLine>
            </div>
          )
        })}
      </div>

      {activeLineOffscreen && (
        <button type="button" className={styles.jumpToLine} onClick={jumpToActiveLine}>
          <Icon name="scroll-down" size={20} />
          Jump to the live line
        </button>
      )}
    </div>
  )
}
