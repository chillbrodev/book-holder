import type { SceneSummary } from '../types/views'

const DAY_MS = 24 * 60 * 60 * 1000

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const days = Math.floor((now.getTime() - then.getTime()) / DAY_MS)

  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks === 1) return '1 week ago'
  if (weeks < 5) return `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  if (months <= 1) return '1 month ago'
  return `${months} months ago`
}

export interface ScenesByAct {
  act: string
  actOrder: number
  scenes: SceneSummary[]
}

export function groupScenesByAct(scenes: SceneSummary[]): ScenesByAct[] {
  const byAct = new Map<string, ScenesByAct>()

  for (const scene of scenes) {
    const existing = byAct.get(scene.act)
    if (existing) {
      existing.scenes.push(scene)
    } else {
      byAct.set(scene.act, { act: scene.act, actOrder: scene.actOrder, scenes: [scene] })
    }
  }

  return Array.from(byAct.values())
    .sort((a, b) => a.actOrder - b.actOrder)
    .map((group) => ({ ...group, scenes: group.scenes.sort((a, b) => a.sceneOrder - b.sceneOrder) }))
}
