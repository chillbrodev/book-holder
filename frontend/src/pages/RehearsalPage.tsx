import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getPlay, getSceneDialogue, getSelectedRole, getSingleLineDialogue, setLastScene } from '../data/client'
import { getBlockAudio } from '../data/pollyClient'
import { saveSession } from '../data/sessionClient'
import { recordSessionSave } from '../data/pendingSessionSave'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../auth/useAuth'
import { useMicCapture } from '../hooks/useMicCapture'
import { DialogueLine } from '../components/rehearsal/DialogueLine'
import { StageDirection } from '../components/rehearsal/StageDirection'
import { MicStateIndicator } from '../components/rehearsal/MicStateIndicator'
import { CaptureDebugInfo } from '../components/rehearsal/CaptureDebugInfo'
import { Button } from '../components/core/Button'
import { Icon } from '../components/core/Icon'
import { ToggleButton } from '../components/core/ToggleButton'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { toDisplayName } from '../utils/format'
import styles from './RehearsalPage.module.css'

const AUTO_ADVANCE_DELAY_MS = 650
const CAPTURED_ADVANCE_DELAY_MS = 500
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

  const { micState, tapMic, retry, beatIndex, beatsCompleted, beatCount, stalled, transcript, heard, setMuted } =
    useMicCapture(activeUserBlockId, role?.id)

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
  }, [playId, act, scene, lineId])

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
    if (lineId || !user || !play) return
    const attempts = [...attemptsRef.current].map(([id, heardText]) => ({
      lineId: id,
      heard: heardText,
    }))
    // Nothing to record: she never reached one of her own lines, or the mic never
    // worked. An empty session is not worth a row.
    if (attempts.length === 0) return

    const result = saveSession({
      playId: play.id,
      act,
      scene,
      durationSeconds: Math.round((Date.now() - startedAtRef.current) / 1000),
      attempts,
    })

    // Handed to the wrap-up so it can read back *this* run rather than racing the
    // write and finding the previous one. Recorded before the catch below, so
    // what's parked is the promise that still carries the session id.
    recordSessionSave({ playId: play.id, act, scene, result })

    void result.catch((err) => {
      // Deliberately not surfaced as a blocking error — see above. Logged so a
      // failure is diagnosable rather than silent. The wrap-up awaits the same
      // promise and is where she's actually told the run wasn't saved.
      console.error('Could not save this rehearsal:', err)
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
    let audio: HTMLAudioElement | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    getBlockAudio(entry.blockId, entry.speakerId)
      .then(({ audioUrl }) => {
        if (cancelled) return
        audio = new Audio(audioUrl)
        audio.addEventListener('ended', () => {
          if (!cancelled) advance()
        })
        audio.addEventListener('error', () => {
          if (!cancelled) advance()
        })
        return audio.play()
      })
      .catch(() => {
        if (!cancelled) fallbackTimer = setTimeout(() => advance(), AUTO_ADVANCE_DELAY_MS)
      })

    return () => {
      cancelled = true
      audio?.pause()
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance() closes over cursor/dialogue, re-derived every render
  }, [cursor, dialogue, done, readingPaused])

  // Her speech is captured, so move on. Previously this needed a second tap,
  // which was pure friction: the app already knew the block was done, and asking
  // her to confirm it made the end of every line a small piece of admin. The
  // delay is just long enough to see the confirmation land.
  useEffect(() => {
    // `activeUserBlockId` is in the condition as well as the state: without it, a
    // `captured` left over from a previous line could advance the scene while
    // somebody else is speaking.
    if (!activeUserBlockId || micState !== 'captured' || done || readingPaused) return
    const timer = setTimeout(() => advance(), CAPTURED_ADVANCE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance() closes over cursor/dialogue, re-derived every render
  }, [activeUserBlockId, micState, done, readingPaused])

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
    setReadingAloudBlockId(blockId)
    setMuted(true)
    try {
      const { audioUrl } = await getBlockAudio(blockId, speakerId)
      const audio = new Audio(audioUrl)
      await new Promise<void>((resolve) => {
        audio.addEventListener('ended', () => resolve())
        audio.addEventListener('error', () => resolve())
        void audio.play().catch(() => resolve())
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
      <header className={styles.header}>
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
        </div>
        <div className={styles.controls}>
          <ToggleButton
            on={!readingPaused}
            label="Scene reading"
            onStateLabel="Playing"
            offStateLabel="Paused"
            onIcon="pause"
            offIcon="play"
            onClick={() => setReadingPaused((v) => !v)}
          />
          <ToggleButton
            on={autoScroll}
            label="Auto-scroll"
            onStateLabel="On"
            offStateLabel="Off"
            onIcon="scroll-down"
            offIcon="scroll-off"
            onClick={() => setAutoScroll((v) => !v)}
          />
          <ToggleButton
            on={showYourLines}
            label="Your lines"
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
            return (
              <div key={entry.blockId} ref={ref} className={styles.lineAnchor}>
                <DialogueLine block={entry} overrideText={showOtherLines ? undefined : ''} />
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
                  />
                </div>
                <CaptureDebugInfo
                  micState={micState}
                  beatIndex={beatIndex}
                  beatCount={entry.beats.length}
                  transcript={transcript}
                />
                <div className={styles.actions}>
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
