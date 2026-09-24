import type { Position, StrengthPlayer, TeamSide } from '@/lib/types'

const DEFAULT_STRENGTH = 6
const PRIOR_MATCHES = 5

export function effectiveStrength(player: StrengthPlayer) {
  if (!player.ratedMatches || player.overallRating === null) return DEFAULT_STRENGTH
  const current = player.recentForm === null
    ? player.overallRating
    : player.overallRating * 0.6 + player.recentForm * 0.4
  const confidence = Math.min(player.ratedMatches / PRIOR_MATCHES, 1)
  return DEFAULT_STRENGTH * (1 - confidence) + current * confidence
}

export interface GeneratedTeams {
  bibs: StrengthPlayer[]
  nonBibs: StrengthPlayer[]
  bibsStrength: number
  nonBibsStrength: number
  difference: number
  balance: number
}

function positionCounts(players: StrengthPlayer[]) {
  return players.reduce<Record<Position, number>>(
    (counts, player) => {
      if (player.preferredPosition) counts[player.preferredPosition] += 1
      return counts
    },
    { GOALKEEPER: 0, DEFENDER: 0, MIDFIELDER: 0, ATTACKER: 0 },
  )
}

function scoreSplit(a: StrengthPlayer[], b: StrengthPlayer[]) {
  const aTotal = a.reduce((sum, player) => sum + effectiveStrength(player), 0)
  const bTotal = b.reduce((sum, player) => sum + effectiveStrength(player), 0)
  const aAverage = a.length ? aTotal / a.length : 0
  const bAverage = b.length ? bTotal / b.length : 0
  const ratingDifference = Math.abs(aAverage - bAverage)
  const aPositions = positionCounts(a)
  const bPositions = positionCounts(b)
  const positionPenalty = (Object.keys(aPositions) as Position[])
    .reduce((sum, position) => sum + Math.abs(aPositions[position] - bPositions[position]), 0) * 0.08
  const keepersA = a.filter((player) => player.goalkeeperWilling || player.preferredPosition === 'GOALKEEPER').length
  const keepersB = b.filter((player) => player.goalkeeperWilling || player.preferredPosition === 'GOALKEEPER').length
  const keeperPenalty = Math.abs(keepersA - keepersB) * 0.25
  return { score: ratingDifference + positionPenalty + keeperPenalty, aAverage, bAverage }
}

function shuffled<T>(values: T[]) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

export function generateFairTeams(players: StrengthPlayer[], attempts = 1500): GeneratedTeams {
  if (players.length < 2) throw new Error('At least two playing participants are required.')
  const bibsSize = Math.ceil(players.length / 2)
  const candidates: Array<{ bibs: StrengthPlayer[]; nonBibs: StrengthPlayer[]; score: number; aAverage: number; bAverage: number }> = []

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = shuffled(players)
    const bibs = candidate.slice(0, bibsSize)
    const nonBibs = candidate.slice(bibsSize)
    const metrics = scoreSplit(bibs, nonBibs)
    candidates.push({ bibs, nonBibs, ...metrics })
  }

  candidates.sort((a, b) => a.score - b.score)
  const fairPool = candidates.slice(0, Math.max(1, Math.min(20, Math.ceil(attempts * 0.02))))
  const selected = fairPool[Math.floor(Math.random() * fairPool.length)]
  const difference = Math.abs(selected.aAverage - selected.bAverage)

  return {
    bibs: selected.bibs,
    nonBibs: selected.nonBibs,
    bibsStrength: selected.aAverage,
    nonBibsStrength: selected.bAverage,
    difference,
    balance: Math.max(0, Math.round(100 - difference * 15)),
  }
}

export function recommendSide(existing: GeneratedTeams, player: StrengthPlayer): TeamSide {
  const onBibs = scoreSplit([...existing.bibs, player], existing.nonBibs).score
  const onNonBibs = scoreSplit(existing.bibs, [...existing.nonBibs, player]).score
  return onBibs <= onNonBibs ? 'BIBS' : 'NON_BIBS'
}
