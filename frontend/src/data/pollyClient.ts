import { apiRequest } from './apiClient'

export interface LineAudio {
  audioUrl: string
  cached: boolean
}

/** Matches api's GET /polly/lines/:lineId/audio?characterId= — cached once
 * per (line, voice) in S3 server-side, so repeat calls for an already-warmed
 * line resolve fast (a signed-URL lookup, not a fresh synthesis). */
export function getLineAudio(lineId: string, characterId: string): Promise<LineAudio> {
  return apiRequest(`/polly/lines/${lineId}/audio?characterId=${characterId}`)
}
