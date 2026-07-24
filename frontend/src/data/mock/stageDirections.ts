import type { StageDirectionEntry } from '../../types/domain'
import { FOCUS_PLAY_ID } from './plays'

const ACT = 'II'
const ACT_ORDER = 2
const SCENE = '1'
const SCENE_ORDER = 1

function stageDirectionId(sequence: number): string {
  return `${FOCUS_PLAY_ID}-${ACT}-${SCENE}-stage-${sequence}`
}

/**
 * Positioned relative to ACT_2_SCENE_1_LINES via (act, scene, afterLineNumber) — no FK to Line,
 * matching the schema. afterLineNumber: 0 means "before the first line."
 */
export const ACT_2_SCENE_1_STAGE_DIRECTIONS: StageDirectionEntry[] = [
  {
    id: stageDirectionId(1),
    playId: FOCUS_PLAY_ID,
    act: ACT,
    actOrder: ACT_ORDER,
    scene: SCENE,
    sceneOrder: SCENE_ORDER,
    sequence: 1,
    afterLineNumber: 0,
    text: 'Enter Mistress Page, with a letter.',
  },
  {
    id: stageDirectionId(2),
    playId: FOCUS_PLAY_ID,
    act: ACT,
    actOrder: ACT_ORDER,
    scene: SCENE,
    sceneOrder: SCENE_ORDER,
    sequence: 2,
    afterLineNumber: 1,
    text: 'She reads.',
  },
  {
    id: stageDirectionId(3),
    playId: FOCUS_PLAY_ID,
    act: ACT,
    actOrder: ACT_ORDER,
    scene: SCENE,
    sceneOrder: SCENE_ORDER,
    sequence: 3,
    afterLineNumber: 3,
    text: 'Enter Mistress Ford.',
  },
  {
    id: stageDirectionId(4),
    playId: FOCUS_PLAY_ID,
    act: ACT,
    actOrder: ACT_ORDER,
    scene: SCENE,
    sceneOrder: SCENE_ORDER,
    sequence: 4,
    afterLineNumber: 12,
    text: 'Enter Ford, Page, Pistol and Nym.',
  },
  {
    id: stageDirectionId(5),
    playId: FOCUS_PLAY_ID,
    act: ACT,
    actOrder: ACT_ORDER,
    scene: SCENE,
    sceneOrder: SCENE_ORDER,
    sequence: 5,
    afterLineNumber: 13,
    text: 'Scene continues — from the top next time.',
  },
]
