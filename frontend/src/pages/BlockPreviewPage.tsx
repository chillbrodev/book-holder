import { useMemo, useState } from 'react'
import { DialogueBlockView } from '../components/rehearsal/DialogueBlockView'
import { StageDirection } from '../components/rehearsal/StageDirection'
import { Button } from '../components/core/Button'
import { ToggleButton } from '../components/core/ToggleButton'
import { FIXTURES, blockText, toDialogueItems } from '../data/fixtureClient'
import styles from './BlockPreviewPage.module.css'

/**
 * Local-only preview of the beats-and-blocks rendering, driven by real importer
 * output (docs/beats-and-blocks-plan.md §12 step 1). No API, no database, no
 * Polly — the point is to judge the segmentation and the verse/prose treatment
 * before migration 004 makes any of it expensive to change.
 *
 * Deliberately a separate page rather than a branch inside RehearsalPage: that
 * page's cursor, mic and auto-scroll effects all still assume one row per
 * entry, and destabilising a working rehearsal flow before the schema has even
 * changed would be the wrong order. Port the verified rendering into it at
 * step 5.
 */
export function BlockPreviewPage() {
  const [fixtureKey, setFixtureKey] = useState<string>('merry-wives-ii-i')
  const [showBeats, setShowBeats] = useState(true)
  const [speaking, setSpeaking] = useState<string | null>(null)

  const fixture = FIXTURES[fixtureKey]
  const items = useMemo(() => toDialogueItems(fixture, null), [fixture])

  const blocks = items.filter((i) => i.type === 'speech')
  const beatCount = blocks.reduce((n, b) => n + (b.type === 'speech' ? b.beats.length : 0), 0)
  const verseBlocks = blocks.filter((b) => b.type === 'speech' && b.isVerse).length

  /**
   * The browser's own speech synthesis, standing in for Polly. Bad voices, but
   * free, and the question it answers is the one that matters here: does a
   * whole block read as one continuous delivery, or does it still sound chopped?
   */
  function speak(blockId: string, text: string) {
    window.speechSynthesis.cancel()
    if (speaking === blockId) {
      setSpeaking(null)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    utterance.onend = () => setSpeaking(null)
    setSpeaking(blockId)
    window.speechSynthesis.speak(utterance)
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          {fixture.play.title} — {fixture.act}.{fixture.scene}
        </h1>
        {fixture.description && <p className={styles.description}>{fixture.description}</p>}
        <p className={styles.stats}>
          {beatCount} beats in {blocks.length} blocks · {verseBlocks} verse, {blocks.length - verseBlocks} prose
        </p>

        <div className={styles.controls}>
          {Object.keys(FIXTURES).map((key) => (
            <Button
              key={key}
              variant={key === fixtureKey ? 'primary' : 'secondary'}
              onClick={() => {
                window.speechSynthesis.cancel()
                setSpeaking(null)
                setFixtureKey(key)
              }}
            >
              {key}
            </Button>
          ))}
          <ToggleButton
            on={showBeats}
            label="Beat divisions"
            onStateLabel="Shown"
            offStateLabel="Hidden"
            onIcon="eye"
            offIcon="eye-off"
            onClick={() => setShowBeats((v) => !v)}
          />
        </div>
      </header>

      <div className={styles.scene}>
        {items.map((item, i) => {
          if (item.type === 'stage') {
            return <StageDirection key={`stage-${i}`}>{item.text}</StageDirection>
          }
          return (
            <div key={item.blockId} className={styles.blockRow}>
              <DialogueBlockView block={item} showBeats={showBeats} active={speaking === item.blockId} />
              <Button variant="ghost" onClick={() => speak(item.blockId, blockText(item))}>
                {speaking === item.blockId ? 'Stop' : 'Hear block'}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
