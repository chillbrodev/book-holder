import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getPlay, getSceneDialogue, getSelectedRole, getSingleLineDialogue, setLastScene } from '../data/client'
import { getBlockAudio } from '../data/pollyClient'
import { useAsync } from '../hooks/useAsync'
import { useMicSimulation } from '../hooks/useMicSimulation'
import { DialogueLine } from '../components/rehearsal/DialogueLine'
import { StageDirection } from '../components/rehearsal/StageDirection'
import { MicStateIndicator } from '../components/rehearsal/MicStateIndicator'
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
  // How many beats of the active block she's called for. 0 = nothing revealed;
  // each "Line?" hands over one more thought, never the whole speech.
  const [beatsRevealed, setBeatsRevealed] = useState(0)
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

  const { micState, tapMic, retry, simulateCantHear } = useMicSimulation(activeLineKey)

  useEffect(() => {
    setBeatsRevealed(0)
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

  function finishRehearsal() {
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

  function handleMicTap() {
    if (micState === 'captured') {
      setTimeout(() => advance(), CAPTURED_ADVANCE_DELAY_MS)
      return
    }
    tapMic()
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
          const nextBeat = entry.beats[beatsRevealed]
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
                promptedBeat={
                  showYourLines ? undefined : entry.beats.slice(0, beatsRevealed).map((b) => b.text).join(' ')
                }
                active
                micError={micState === 'cantHear'}
              >
                <div className={styles.micRow}>
                  <MicStateIndicator state={micState} onTap={handleMicTap} />
                </div>
                <div className={styles.actions}>
                  {micState === 'cantHear' && (
                    <Button variant="secondary" onClick={retry}>
                      Try again
                    </Button>
                  )}
                  {!showYourLines && micState !== 'captured' && nextBeat && (
                    <Button variant="ghost" onClick={() => setBeatsRevealed((n) => n + 1)}>
                      {beatsRevealed === 0 ? 'Line?' : 'Next bit?'}
                    </Button>
                  )}
                  {beatsRevealed > 0 && !showYourLines && <Button variant="secondary">Read line aloud</Button>}
                  {micState === 'listening' && (
                    <button type="button" className={styles.debugLink} onClick={simulateCantHear}>
                      Simulate: can't hear you
                    </button>
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
