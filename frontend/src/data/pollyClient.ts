import { apiRequest } from './apiClient'

export interface LineAudio {
  audioUrl: string
  cached: boolean
}

/** Matches api's GET /polly/blocks/:blockId/audio?characterId=, cached once
 * per (block, voice) in S3 server-side, so repeat calls for an already-warmed
 * block resolve fast (a signed-URL lookup, not a fresh synthesis).
 *
 * A block, not a beat: the server concatenates that block's beats and
 * synthesizes the speech whole. Rendering beat by beat gives each fragment
 * sentence-final intonation and a trailing pause, audible as stop-start
 * delivery, and baked into the bytes rather than fixable at playback. */
export function getBlockAudio(blockId: string, characterId: string): Promise<LineAudio> {
  return apiRequest(`/polly/blocks/${blockId}/audio?characterId=${characterId}`)
}
