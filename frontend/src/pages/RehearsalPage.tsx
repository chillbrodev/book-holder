import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getSceneDialogue, getSingleLineDialogue } from '../data/client'
import { getLineAudio } from '../data/pollyClient'
import { useAsync } from '../hooks/useAsync'
import { useMicSimulation } from '../hooks/useMicSimulation'
import { DialogueLine } from '../components/rehearsal/DialogueLine'
import { StageDirection } from '../components/rehearsal/StageDirection'
import { MicStateIndicator } from '../components/rehearsal/MicStateIndicator'
import { Button } from '../components/core/Button'
import { AsyncStatus } from '../components/core/AsyncStatus'
import styles from './RehearsalPage.module.css'

const AUTO_ADVANCE_DELAY_MS = 650
const CAPTURED_ADVANCE_DELAY_MS = 500

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

  const [cursor, setCursor] = useState(0)
  const [textVisible, setTextVisible] = useState(false)
  const [lineRevealed, setLineRevealed] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    setCursor(0)
    setDone(false)
  }, [dialogue])

  const activeEntry = dialogue?.[cursor]
  const activeLineKey = activeEntry?.lineId ?? `entry-${cursor}`

  const { micState, tapMic, retry, simulateCantHear } = useMicSimulation(activeLineKey)

  useEffect(() => {
    setLineRevealed(false)
  }, [activeLineKey])

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
    if (!dialogue || done) return
    const entry = dialogue[cursor]
    if (!entry) return
    if (entry.type === 'speech' && entry.isUserLine) return
    if (entry.type === 'speech' && entry.lineId && entry.speakerId) return

    const timer = setTimeout(() => advance(), AUTO_ADVANCE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance()/finishRehearsal() close over cursor/dialogue, re-derived every render
  }, [cursor, dialogue, done])

  // Other characters' lines: fetch real Polly audio and advance when it
  // finishes playing, rather than a fixed delay. Falls back to the timer if
  // Polly errors — graceful degradation per docs/BE_PLAN.md §5, so a
  // synthesis failure never blocks the rehearsal.
  useEffect(() => {
    if (!dialogue || done) return
    const entry = dialogue[cursor]
    if (!entry || entry.type !== 'speech' || entry.isUserLine) return
    if (!entry.lineId || !entry.speakerId) return

    let cancelled = false
    let audio: HTMLAudioElement | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    getLineAudio(entry.lineId, entry.speakerId)
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
  }, [cursor, dialogue, done])

  function handleMicTap() {
    if (micState === 'captured') {
      setTimeout(() => advance(), CAPTURED_ADVANCE_DELAY_MS)
      return
    }
    tapMic()
  }

  const backHref = backTo ?? `/play/${playId}/scenes`
  const backLabel = backTo?.includes('wrap-up') ? 'Back to wrap-up' : backTo?.includes('prompt-book') ? 'Back to Prompt Book' : 'Scene picker'

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
  const textShown = textVisible || lineRevealed

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <Link to={backHref} className={styles.backLink}>
          ← {backLabel}
        </Link>
        <div
          className={styles.showTextToggle}
          onClick={() => {
            setTextVisible((v) => !v)
            setLineRevealed(false)
          }}
        >
          {textVisible ? 'Hide text' : 'Show text'}
        </div>
      </div>
      <div className={`bh-eyebrow ${styles.eyebrow}`}>
        Act {act}, Scene {scene}
      </div>

      <div className={styles.lines}>
        {visible.map((entry, i) => {
          const active = i === cursor && entry.type === 'speech' && entry.isUserLine
          if (entry.type === 'stage') {
            return <StageDirection key={`stage-${i}`}>{entry.text}</StageDirection>
          }
          if (!active) {
            return <DialogueLine key={entry.lineId ?? i} speaker={entry.speaker} coSpeakers={entry.coSpeakers} text={entry.text} />
          }
          return (
            <DialogueLine
              key={entry.lineId ?? i}
              speaker={entry.speaker}
              coSpeakers={entry.coSpeakers}
              text={textShown ? entry.text : "Line's held back — call for it below if you need it."}
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
                {!textVisible && micState !== 'captured' && (
                  <Button variant="ghost" onClick={() => setLineRevealed(true)}>
                    Line?
                  </Button>
                )}
                {lineRevealed && !textVisible && <Button variant="secondary">Read line aloud</Button>}
                {micState === 'listening' && (
                  <button type="button" className={styles.debugLink} onClick={simulateCantHear}>
                    Simulate: can't hear you
                  </button>
                )}
              </div>
            </DialogueLine>
          )
        })}
      </div>
    </div>
  )
}
