import type { Character } from '../../types/domain'
import { FOCUS_PLAY_ID } from './plays'

export const USER_CHARACTER_ID = 'mistress-ford'

export const MOCK_CHARACTERS: Character[] = [
  { id: 'mistress-ford', playId: FOCUS_PLAY_ID, name: 'Mistress Ford', isSynthetic: false },
  { id: 'page', playId: FOCUS_PLAY_ID, name: 'Page', isSynthetic: false },
  { id: 'mistress-page', playId: FOCUS_PLAY_ID, name: 'Mistress Page', isSynthetic: false },
  { id: 'shallow', playId: FOCUS_PLAY_ID, name: 'Shallow', isSynthetic: false },
  { id: 'slender', playId: FOCUS_PLAY_ID, name: 'Slender', isSynthetic: false },
  { id: 'falstaff', playId: FOCUS_PLAY_ID, name: 'Sir John Falstaff', isSynthetic: false },
  { id: 'mistress-quickly', playId: FOCUS_PLAY_ID, name: 'Mistress Quickly', isSynthetic: false },
]
