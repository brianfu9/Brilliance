// Shared model capability classification used by both the per-model page and the parallel QueuePanel.
import type { FleetModel } from "./api"

export type Kind = "chat" | "embed" | "gen"

export const NOUN: Record<string, string> = {
  image_generation: "Images generated",
  shape_generation: "Meshes generated",
  audio_generation: "Clips generated",
  video_generation: "Videos generated",
}

export function kindOf(c: Record<string, unknown> | undefined): [Kind, string] {
  for (const k of Object.keys(NOUN)) if (c?.[k]) return ["gen", NOUN[k]]
  if (c?.chat) return ["chat", ""]
  if (c?.embedding) return ["embed", ""]
  return ["chat", ""]
}

/**
 * Returns a predicate testing whether `otherId` may share an accelerator card with `targetId`,
 * using `FleetModel.cards` as the card assignment proxy (conservative when card info is absent).
 */
export function sameCardMatcher(
  targetId: string,
  models: readonly FleetModel[],
): (otherId: string) => boolean {
  const byId = new Map(models.map((m) => [m.id, m]))
  const targetCards = byId.get(targetId)?.cards
  if (!targetCards || targetCards.length === 0) {
    return (otherId: string) => otherId !== targetId
  }
  const cardSet = new Set(targetCards)
  return (otherId: string) => {
    if (otherId === targetId) return false
    const otherCards = byId.get(otherId)?.cards
    if (!otherCards || otherCards.length === 0) return true
    return otherCards.some((c) => cardSet.has(c))
  }
}
