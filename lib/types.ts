export type UserRole = 'ADMIN' | 'PLAYER'
export type AccountStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
export type Position = 'GOALKEEPER' | 'DEFENDER' | 'MIDFIELDER' | 'ATTACKER'
export type MatchStatus =
  | 'DRAFT'
  | 'AVAILABILITY_OPEN'
  | 'TEAMS_GENERATED'
  | 'PLAYED'
  | 'VOTING_OPEN'
  | 'FINALISED'
  | 'CANCELLED'
export type AvailabilityStatus = 'PLAYING' | 'WATCHING' | 'MAYBE' | 'NOT_ATTENDING'
export type TeamSide = 'BIBS' | 'NON_BIBS'

export interface Profile {
  id: string
  email: string
  full_name: string
  nickname: string | null
  avatar_url: string | null
  bio: string | null
  preferred_position: Position | null
  secondary_position: Position | null
  role: UserRole
  status: AccountStatus
  is_owner: boolean
  goalkeeper_willing: boolean
  comment_restricted: boolean
  created_at: string
}

export type PublicPlayer = Pick<Profile,
  'id' | 'full_name' | 'nickname' | 'avatar_url' | 'bio' |
  'preferred_position' | 'secondary_position' | 'goalkeeper_willing'>

export interface Venue {
  id: string
  name: string
  address: string
  pitch: string | null
  notes: string | null
  active: boolean
}

export interface Match {
  id: string
  title: string
  starts_at: string
  availability_deadline: string | null
  availability_locked: boolean
  max_players: number | null
  status: MatchStatus
  notes: string | null
  venue_id: string | null
  bibs_score: number | null
  non_bibs_score: number | null
  voting_opens_at: string | null
  voting_closes_at: string | null
  venue?: Venue | null
}

export interface Availability {
  match_id: string
  player_id: string
  status: AvailabilityStatus
  profile?: Pick<Profile, 'id' | 'full_name' | 'nickname' | 'avatar_url'>
}

export interface TeamAssignment {
  match_id: string
  player_id: string
  side: TeamSide
  player?: Profile
}

export interface PlayerStats {
  player_id: string
  matches_played: number
  matches_won: number
  matches_drawn: number
  matches_lost: number
  goals: number
  motm_awards: number
  overall_rating: number | null
  recent_form: number | null
  highest_rating: number | null
  attendance_percentage: number | null
}

export interface StrengthPlayer {
  id: string
  name: string
  preferredPosition: Position | null
  secondaryPosition: Position | null
  goalkeeperWilling: boolean
  overallRating: number | null
  recentForm: number | null
  ratedMatches: number
}

export interface GameDateOption {
  id: string
  poll_id: string
  starts_at: string
}

export interface GameDatePoll {
  id: string
  title: string
  notes: string | null
  venue_id: string | null
  closes_at: string | null
  status: 'OPEN' | 'CLOSED'
  venue?: Venue | null
  options?: GameDateOption[]
}

export interface GameDatePollCount {
  option_id: string
  poll_id: string
  vote_count: number
}
