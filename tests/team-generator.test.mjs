import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveStrength, generateFairTeams, recommendSide } from '../lib/domain/team-generator.ts'

function player(id, options = {}) {
  return {
    id,
    name: id,
    preferredPosition: null,
    secondaryPosition: null,
    goalkeeperWilling: false,
    overallRating: null,
    recentForm: null,
    ratedMatches: 0,
    ...options,
  }
}

test('unrated players start at the neutral strength', () => {
  assert.equal(effectiveStrength(player('new')), 6)
  assert.ok(Math.abs(effectiveStrength(player('partial', { overallRating: 9, recentForm: 8, ratedMatches: 1 })) - 6.52) < 0.0001)
  assert.ok(Math.abs(effectiveStrength(player('regular', { overallRating: 8, recentForm: 7, ratedMatches: 5 })) - 7.6) < 0.0001)
})

test('odd squads split by at most one with every player assigned once', () => {
  const squad = Array.from({ length: 9 }, (_, index) => player(String(index)))
  const teams = generateFairTeams(squad, 100)
  assert.equal(teams.bibs.length, 5)
  assert.equal(teams.nonBibs.length, 4)
  assert.deepEqual(new Set([...teams.bibs, ...teams.nonBibs].map(({ id }) => id)), new Set(squad.map(({ id }) => id)))
})

test('two willing goalkeepers are distributed between balanced teams', () => {
  const squad = [player('gk1', { goalkeeperWilling: true }), player('gk2', { goalkeeperWilling: true }),
    player('a'), player('b'), player('c'), player('d')]
  const teams = generateFairTeams(squad, 300)
  assert.equal(teams.bibs.filter((member) => member.goalkeeperWilling).length, 1)
  assert.equal(teams.nonBibs.filter((member) => member.goalkeeperWilling).length, 1)
  assert.ok(['BIBS', 'NON_BIBS'].includes(recommendSide(teams, player('late'))))
})

test('cannot generate a team sheet for one player', () => {
  assert.throws(() => generateFairTeams([player('alone')]), /At least two/)
})
