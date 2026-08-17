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
 * Measured coaching latency is 0.8-1.3s, so this usually expires unused, the
 * score lands first and `SCORE_SEEN_MS` takes over. It exists for the cases
 * where nothing is coming at all: Bedrock unreachable, the socket lost, a guest
 * whose connection dropped. The scene must never stall on feedback.
 */
const SCORE_WAIT_CAP_MS = 1500

/**
 * `worthAPause` and `AUTO_CONTINUE_MS` lived here.
 *
 * The scene used to stop after any speech with a non-solid beat or a note, so
 * she could read the marks under it, and a "Continue" button skipped the
 * remaining wait. Both are gone: the per-beat bands now live on the wrap-up,
 * where they are a record rather than an interruption, and a pause that displays
 * nothing is just the scene hanging.
 *
 * What survives is the short wait for the score itself (`SCORE_WAIT_CAP_MS`,
 * `SCORE_SEEN_MS`), because the socket still has to be given a moment to deliver
 * one — it is written to the session either way, and it is what the wrap-up
 * reads back.
 */
const AUTO_SCROLL_STORAGE_KEY = 'bh:autoScroll'

export function RehearsalPage() {
  const { playId = '', act = '', scene = '' } = useParams()
  const [searchParams] = useSearchParams()
  const lineId = searchParams.get('line')
  const backTo = searchParams.get('back')
  /**
   * A drill over a chosen set of speeches, rather than the whole scene.
   *
   * This is migration 008's block-scoped session reaching the UI: a session is a
   * set of blocks and a scene is only one kind of set, so running three speeches
   * is a rehearsal that can be *finished* rather than a scene abandoned after
   * three. The wrap-up's "Practice these lines" is the first caller; the coach
   * agent will be the second, with `source: 'coach'` so its recommendation can
   * be checked against what she actually ran.
   *
   * Distinct from `?line=`, which drills a single speech and deliberately saves
   * nothing.
   */
  const drillBlockIds = (searchParams.get('blocks') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const isDrill = drillBlockIds.length > 0
  const navigate = useNavigate()
  // Only a signed-in user has anywhere to save a session to (sessionClient.ts).
  const { user } = useAuth()

  const { data: dialogue, loading, error } = useAsync(
    async () => {
      if (lineId) return await getSingleLineDialogue(playId, lineId)
      const full = await getSceneDialogue(playId, act, scene)
      if (!isDrill) return full
      // Only the chosen speeches. Stage directions and the other characters'
      // lines are dropped: a drill is a run at the speeches themselves, and
      // playing the scene around them would make a three-speech practice take
      // as long as the scene it came from.
      const wanted = new Set(drillBlockIds)
      return full.filter((entry) => entry.type === 'speech' && wanted.has(entry.blockId))
    },
    [playId, act, scene, lineId, drillBlockIds.join(',')],
  )
  const { data: play } = useAsync(() => getPlay(playId), [playId])
  const { data: role } = useAsync(() => getSelectedRole(playId), [playId])

  const [cursor, setCursor] = useState(0)
  const [showYourLines, setShowYourLines] = useState(false)
  const [showOtherLines, setShowOtherLines] = useState(true)
  const [readingPaused, setReadingPaused] = useState(false)
  /**
   * Whether she has asked to see the live speech, when her lines are held back.
   *
   * One flag for the whole speech, not a set of beats. Two earlier designs got
   * this wrong in the same direction: revealing one thought per tap made an
   * eleven-beat speech eleven taps, and the reason for rationing it — that
   * handing over a long speech at once is the answer rather than a prompt — only
   * held while the speech arrived as an undifferentiated wall of text. With the
   * prompter lighting the beat she is on, the whole speech on screen *is* a
   * prompt. Ration nothing; mark her place instead.
   *
   * Reset per block, so the next speech is a fresh test.
   */
  const [linesRevealed, setLinesRevealed] = useState(false)
  // Which block is currently being read aloud to her, if any, so the button can
  // say so and can't be triggered twice over itself.
  const [readingAloudBlockId, setReadingAloudBlockId] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // Persisted across sessions, not just this scene, someone who turns it
  // off wants it off everywhere, not re-prompted every rehearsal.
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== 'off')
  // Phone only: whether the play title and the change-scene/role links are
  // showing. Closed by default because on a 390px screen that block cost ~90px
  // of a permanently pinned header to tell her the name of the play she just
  // chose and offer two links she needs about once a rehearsal. Above 600px the
  // disclosure button is display:none and the meta is always shown, so this
  // state exists but governs nothing; the desktop header is unchanged.
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
  // single-line practice run (`?line=`), that's a drill launched from
  // somewhere else, not a place in the play to come back to.
  useEffect(() => {
    if (!lineId && act && scene) setLastScene(playId, act, scene)
  }, [playId, act, scene, lineId])

  useEffect(() => {
    setCursor(0)
    setDone(false)
  }, [dialogue])

  const activeEntry = dialogue?.[cursor]
  // Keyed on the block, not a beat; the mic stays open across a whole speech,
  // so resetting its state at every beat boundary would interrupt exactly the
  // continuous delivery beats exist to avoid scoring away.
  const activeLineKey = activeEntry?.type === 'speech' ? activeEntry.blockId : `entry-${cursor}`

  // The mic opens only for her own blocks. Polly voices everybody else, and the
  // two never contend, so passing undefined here is what keeps a live mic (and
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
  /** Dismissed for this rehearsal. Not persisted; it is a statement of fact
   * about *this* run, and a guest starting a new scene should be told again. */
  const [noticeDismissed, setNoticeDismissed] = useState(false)

  /**
   * Every block's score, keyed by blockId.
   *
   * Filed by callback rather than read off the live block, because a score
   * arrives about a second after `complete` and the page has usually advanced
   * by then, the block it belongs to is no longer the active one. The event
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
   * Skipped for a single-beat drill (`?line=`); that is a practice run rather
   * than a rehearsal of a scene, and for guests, who have no user row to hang
   * a session on.
   *
   * A failure here is deliberately not surfaced. She can still rehearse, still
   * be listened to, and still be coached; the run simply isn't remembered,
   * which is the guest experience and not an error worth a dialog mid-scene.
   */
  useEffect(() => {
    if (lineId || !user || !play || !role) return
    let cancelled = false
    startSession({
      playId: play.id,
      act,
      scene,
      characterId: role.id,
      // A drill records exactly the speeches it set out to run, so finishing it
      // is a real completion rather than a scene abandoned early. `source` is
      // 'user' because she chose these from her own flagged lines; the coach
      // agent will pass 'coach', which is what makes its recommendations
      // checkable against what she actually ran.
      ...(isDrill ? { scope: 'blocks' as const, blockIds: drillBlockIds, source: 'user' as const } : {}),
    })
      .then((started) => {
        if (!cancelled) setSessionId(started.sessionId)
      })
      .catch((err) => {
        // Told, not just logged. See `notRemembered` below. She can carry on
        // either way, but she should not find out at the wrap-up that a scene
        // she just ran was never written down.
        console.warn('This rehearsal will not be remembered:', err)
        if (!cancelled) setSessionFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ids, deliberately, not the objects: `play`, `role` and `user` are re-derived every render, and depending on them would open a fresh session on each one
  }, [play?.id, act, scene, role?.id, user?.id, lineId, drillBlockIds.join(',')])

  // The per-beat split arrives with the capture's `complete` event. This is the
  // point where what she said stops being ephemeral, until now it was computed,
  // sent to the browser, and dropped on the next block.
  useEffect(() => {
    for (const beat of heard) {
      attemptsRef.current.set(beat.lineId, beat.heard)
    }
  }, [heard])

  // Reveals belong to one speech. Carrying them into the next block would mean
  // arriving at a fresh speech with beats already filled in that she never asked
  // for, which is the app rehearsing for her.
  useEffect(() => {
    setLinesRevealed(false)
  }, [activeLineKey])

  const activeLineRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const liveBarRef = useRef<HTMLDivElement>(null)

  /**
   * Publishes the sticky header's height as `--bh-rehearsal-header`, which
   * `.lineAnchor`'s `scroll-margin-top` consumes.
   *
   * `scrollIntoView({ block: 'start' })` aligns to the top of the *scroll
   * container*, and knows nothing about a sticky header floating over it — so
   * without this the active speech lands underneath the header and the speaker
   * name and first two lines are simply not there.
   *
   * Measured rather than hardcoded because the header is two different heights:
   * on a phone the play title and the change links collapse behind
   * `data-meta-open`, and a constant tuned on a laptop would leave a phone with
   * ~90px of dead space above every speech. Re-measured on resize and on the
   * toggle, which are the only two things that change it.
   */
  useEffect(() => {
    const header = headerRef.current
    const wrap = wrapRef.current
    if (!header || !wrap) return

    const publish = () => {
      wrap.style.setProperty('--bh-rehearsal-header', `${header.offsetHeight}px`)
      // And how much room is left under it, which is what bounds the live
      // speech card. Derived from the header's own bottom edge rather than by
      // subtracting a guess at the app chrome: the header is sticky to the top
      // of the scroll region, so its bottom *is* the top of the usable area,
      // whether or not it has stuck yet. One measurement, no magic numbers, and
      // correct on any viewport.
      const available = window.innerHeight - header.getBoundingClientRect().bottom
      wrap.style.setProperty('--bh-rehearsal-available', `${Math.max(240, Math.round(available))}px`)
    }
    publish()
    window.addEventListener('resize', publish)

    const observer = new ResizeObserver(publish)
    observer.observe(header)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', publish)
    }
    // `dialogue` is in here because the first render returns <AsyncStatus/> —
    // no header exists yet, the effect bails, and without a re-run the custom
    // properties would never be published at all. Found exactly that way: both
    // variables read back as empty strings in the live page.
  }, [sceneMetaOpen, dialogue])

  /**
   * Publishes the pinned bar's height as `--bh-live-bar-height`, which `.lines`
   * turns into bottom clearance.
   *
   * Measured rather than assumed because the bar's height is not fixed: it holds
   * between one and three buttons depending on mic state, and wraps to a second
   * row on a narrow screen. A constant would be too small in exactly the case
   * that matters — several buttons showing, which is when she needs to see both
   * them and the end of her speech.
   */
  useEffect(() => {
    const bar = liveBarRef.current
    const wrap = wrapRef.current
    if (!wrap) return
    if (!bar) {
      // No bar while another character is speaking; drop the clearance with it
      // rather than leaving a bar-shaped gap under the script all scene.
      wrap.style.setProperty('--bh-live-bar-height', '0px')
      return
    }

    const publish = () => wrap.style.setProperty('--bh-live-bar-height', `${bar.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [activeUserBlockId, micState, linesRevealed, showYourLines])

  // Brings the active card into view when the rehearsal moves to a new line.
  //
  // `block: 'start'` rather than 'end', and that is the fix for the second half
  // of the long-speech problem. Aligning the *end* of a card taller than the
  // viewport puts its bottom at the bottom of the screen — which pushes the top
  // of the speech, where she is actually reading, off the top. It was right when
  // every block was a few lines and wrong the moment one wasn't. Aligning the
  // start puts the speaker name and the first line where she expects them, and
  // the speech's own pane handles everything below that.
  //
  // The reveal no longer appears in the deps, because a reveal no longer changes
  // the card's height: a held-back row already occupies its full size (see
  // Teleprompter.module.css). That dependency was re-firing a page scroll on
  // every "Line?" tap, on top of the pane's own scroll.
  useEffect(() => {
    if (!autoScroll) return
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [cursor, showYourLines, showOtherLines, micState, autoScroll])

  // With auto-scroll off, the rehearsal keeps advancing while the view stays
  // put, so the live line silently ends up below the fold with nothing on
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
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
   * Fire-and-forget on purpose; the navigation does not wait on the write, and a
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
    // session never opened. Nothing to close in any of those cases, and
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
    // be; the beats are already down, but the closing call still has to land
    // before the summary is read, or the duration is missing.
    recordSessionSave({ playId: play.id, act, scene, result })

    void result.catch((err) => {
      // Not surfaced as a blocking error: she has finished the scene and is on
      // her way to the wrap-up, which is where a failure is worth mentioning.
      // Note what is *not* lost here any more; the rehearsal itself is already
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
  // other-character speech is handled by the audio effect below instead,
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
  // Polly errors, graceful degradation per docs/BE_PLAN.md §5, so a
  // synthesis failure never blocks the rehearsal.
  // Pausing tears this effect down, which stops the audio mid-line; resuming
  // re-runs it and replays that line from its start rather than resuming
  // mid-word. For a rehearsal cue that's the useful behaviour, you paused
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
        // play is not a missing cue to skip past; nothing is wrong with the
        // audio, and skipping runs the whole scene down in silence 650ms at a
        // time until it reaches her next line. So it stops and asks, and the
        // tap on that prompt is the gesture that buys back playback.
        if (isPlaybackBlocked(error)) {
          setAudioBlocked(true)
          return
        }
        // A genuinely broken cue, synthesis failed, the signed URL 403'd.
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
   * Her speech is captured, so move on, but not before she has seen how it
   * went.
   *
   * This reverses `coaching-plan.md` §4's "advancing to the next block never
   * waits on a score". That rule was right about the danger and wrong about
   * the arithmetic. It assumed the annotation could land late and still be read,
   * because she would be listening to the next character and could glance back.
   * With auto-scroll on there is nothing to glance at: the score arrives ~1s
   * after `complete`, the page advanced 500ms after it, and the pills rendered
   * under a speech that had already left the screen. Non-interruptive was
   * satisfied; the intent behind it wasn't. Coaching she never sees is coaching
   * that isn't happening.
   *
   * So the scene waits for the score, and then for a moment longer, capped, so
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
    // One wait, whatever the score said. The scene used to hold six seconds on a
    // speech that went badly so its marks could be read; the marks are on the
    // wrap-up now, and stopping the rehearsal to display nothing would be the
    // per-line confirmation tap this page removed once already.
    const delay = score ? SCORE_SEEN_MS : Math.max(0, SCORE_WAIT_CAP_MS - waitedFor)

    const timer = setTimeout(() => advance(), delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance() closes over cursor/dialogue, re-derived every render
  }, [activeUserBlockId, micState, done, readingPaused, coachingByBlock])

  /**
   * Plays her own line back to her.
   *
   * Answers OPEN_ITEMS §3's open question, whether she can ask to hear her own
   * lines, in the affirmative, but only on request. The scene reading still
   * skips her lines, because voicing them unasked would rehearse the speech
   * *for* her. Called for after "Line?", when she's already admitted she doesn't
   * have it and reading it hasn't been enough.
   *
   * Mutes the mic for the duration. Polly out of the same laptop the mic is on
   * gets transcribed as her words otherwise, barge-in (docs/capture-plan.md §8),
   * and self-inflicted here rather than incidental. Her own block is in the warm
   * cache like every other, so this is a signed-URL lookup, not a paid synthesis.
   */
  async function readLineAloud(blockId: string, speakerId: string) {
    if (readingAloudBlockId) return
    // Synchronous, before the first await, while this click's activation is
    // still live. It is nearly always a no-op by now, the first tap anywhere
    // in the app already unlocked playback (AppLayout), but this is the one
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
  /** The speech she is delivering right now, or undefined when it is somebody
   * else's turn. Drives the pinned control bar, which exists only while there is
   * something for her to press. */
  const current = dialogue?.[cursor]
  const activeUserBlock = current?.type === 'speech' && current.isUserLine ? current : undefined

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {/* data-meta-open governs the phone layout only — it gates the play title
          and the two change links, which above 600px are shown unconditionally.
          One flag on the header rather than a prop on each, because they hide
          and reveal together and are not adjacent in the DOM. */}
      <header className={styles.header} ref={headerRef} data-meta-open={sceneMetaOpen || undefined}>
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
              // Turning the text off again re-hides it: showing it was an answer
              // to "I'm stuck", and she has just said she wants to be tested.
              setLinesRevealed(false)
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
            // Speaker name stays even when the text is hidden, she still needs
            // to follow who's talking to know when her cue lands.
            //
            // No annotation on a finished speech any more: the marks are on the
            // wrap-up. `coachingByBlock` is still filled as scores arrive — it is
            // what the session write and the wrap-up read — it simply is not
            // rendered here.
            return (
              <div key={entry.blockId} ref={ref} className={styles.lineAnchor}>
                <DialogueLine block={entry} overrideText={showOtherLines ? undefined : ''} />
              </div>
            )
          }
          // Her own block: the prompter, and nothing else. The mic dial and the
          // buttons used to live in here and are now in the pinned bar below —
          // see `.liveBar`. Inside the card they sat under a speech that could
          // be taller than the screen, so on a monologue they were simply not
          // reachable.
          return (
            <div key={entry.blockId} ref={ref} className={styles.lineAnchor}>
              <DialogueLine
                block={entry}
                prompter={{
                  beatIndex: Math.min(beatIndex, entry.beats.length - 1),
                  // Masked until she asks, unless "Your lines" is on outright.
                  masked: !showYourLines && !linesRevealed,
                  // Once the mic has stopped, the speech stops following
                  // anything. She is reading back what she just did, and a pane
                  // still chasing a cursor would move under her while she does.
                  frozen: micState === 'captured' || micState === 'cantHear',
                }}
                active
                micError={micState === 'cantHear'}
              >
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
              </DialogueLine>
            </div>
          )
        })}
      </div>

      {/* The live controls, pinned to the viewport rather than trailing the
          speech.

          They were inside the active card until a monologue proved that wrong:
          Fenton's IV.vi speech is 45 lines of verse, so "I've said it" and
          "Line?" sat a screen and a half below the fold, and the reveal walked
          them further down with every tap. Nothing about a control that is only
          reachable by scrolling away from the words you are performing is
          salvageable by making the card shorter.

          Rendered only while her own speech is live. There is deliberately no
          bar during another character's lines: there is nothing to press, and a
          persistent empty bar would eat the bottom of the script all scene. */}
      {activeUserBlock && (
        <div className={styles.liveBar} ref={liveBarRef}>
          <MicStateIndicator
            state={micState}
            onTap={tapMic}
            beatsCompleted={beatsCompleted}
            beatCount={beatCount}
            stalled={stalled}
          />
          <div className={styles.liveActions}>
            {micState === 'cantHear' && (
              <Button variant="secondary" onClick={retry}>
                Try again
              </Button>
            )}
            {/* The way out when the app can't tell she's finished — a real
                button, because the tappable mic dial reads as a status light and
                nobody finds it. Promoted to primary once she's gone quiet
                mid-thought, when it's the likeliest thing she wants. */}
            {micState === 'listening' && (
              <Button variant={stalled ? 'primary' : 'secondary'} onClick={tapMic}>
                I've said it
              </Button>
            )}
            {/* One tap, and the whole speech is there with her place marked.
                "Line?" then "Next bit?" over and over was the old shape, and it
                was rationing something that stopped being dangerous the moment
                the prompter could show her where she is. */}
            {!showYourLines && !linesRevealed && micState !== 'captured' && (
              <Button variant="ghost" onClick={() => setLinesRevealed(true)}>
                Show lines
              </Button>
            )}
            {linesRevealed && !showYourLines && activeUserBlock.speakerId && (
              <Button
                variant="secondary"
                onClick={() => void readLineAloud(activeUserBlock.blockId, activeUserBlock.speakerId)}
                disabled={readingAloudBlockId !== null}
              >
                {readingAloudBlockId === activeUserBlock.blockId ? 'Reading…' : 'Read line aloud'}
              </Button>
            )}
          </div>
        </div>
      )}

      {activeLineOffscreen && (
        <button type="button" className={styles.jumpToLine} onClick={jumpToActiveLine}>
          <Icon name="scroll-down" size={20} />
          Jump to the live line
        </button>
      )}
    </div>
  )
}
