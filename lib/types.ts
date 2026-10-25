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

export type SessionStatus = 'PLANNING' | 'OPEN' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'
export type AttendanceStatus = 'CONFIRMED' | 'UNCONFIRMED' | 'CANCELLED'
export type PaymentRequestStatus = 'PENDING' | 'FAILED' | 'PAID' | 'MANUALLY_PAID' | 'REFUNDED' | 'CANCELLED' | 'SUPERSEDED'
export type PaymentMethod = 'STRIPE' | 'BANK_TRANSFER' | 'CASH' | 'OTHER'
export type FinancePermission = 'sessions.manage' | 'attendance.manage' | 'payments.request' | 'finance.view'
  | 'payments.record_manual' | 'payments.refund' | 'settings.manage' | 'owner'

export interface PitchSession {
  id: string
  title: string
  starts_at: string
  duration_minutes: number
  venue_id: string | null
  venue_name: string | null
  pitch_name: string | null
  pitch_type: string | null
  pitch_cost_pence: number
  fee_mode: 'ABSORB' | 'COVER_IN_PRICE'
  notes: string | null
  payment_deadline: string | null
  status: SessionStatus
  match_id: string | null
  calc_version: number
  cancelled_reason: string | null
  is_test?: boolean
  venue?: Pick<Venue, 'name' | 'address' | 'pitch'> | null
}

/** session_totals() in the database. Finance-only fields are absent without finance.view. */
export interface SessionTotals {
  pitch_cost_pence: number
  fee_mode: PitchSession['fee_mode']
  calc_version: number
  fee_percent_bps: number
  fee_fixed_pence: number
  chargeable_count: number
  allocation_total_pence: number
  base_share_pence: number
  extra_penny_count: number
  fee_cover_pence: number
  estimated_fees_all_stripe_pence: number
  expected_net_all_stripe_pence: number
  stale_request_count: number
  gross_received_pence?: number
  refunded_pence?: number
  fees_actual_pence?: number
  fees_estimated_unconfirmed_pence?: number
  fees_include_estimates?: boolean
  net_received_pence?: number
  outstanding_pence?: number
  credit_pence?: number
  projected_net_pence?: number
  shortfall_pence?: number
  covered?: boolean
  paid_count?: number
  unpaid_count?: number
  stripe_payment_count?: number
  manual_payment_count?: number
  needs_review_count?: number
}

export interface SessionListItem extends PitchSession { confirmed_count: number; totals: SessionTotals }

export interface SessionAttendee {
  id: string
  session_id: string
  profile_id: string | null
  display_name: string
  attendance: AttendanceStatus
  chargeable: boolean
  note: string | null
  share_pence: number
  extra_penny: boolean
  paid_pence: number | null
  refunded_pence: number | null
  outstanding_pence: number | null
  active_request_id: string | null
  active_request_pence: number | null
}

export interface PaymentRequest {
  id: string
  attendee_id: string
  amount_pence: number
  status: PaymentRequestStatus
  calc_version: number
  calculation: { share_pence: number; chargeable_count: number; allocation_total_pence: number; already_paid_pence: number; extra_penny: boolean }
  due_at: string | null
  issued_at: string
  paid_at: string | null
  closed_reason: string | null
  last_error: string | null
  checkouts: Array<{ attempt: number; status: string; expires_at: string; created_at: string }>
}

export interface PaymentRefund { id: string; amount_pence: number; method: 'STRIPE' | 'MANUAL'; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; reason: string; error: string | null; created_at: string }

export interface Payment {
  id: string
  attendee_id: string
  payment_request_id: string | null
  method: PaymentMethod
  amount_pence: number
  refunded_pence: number
  status: 'SUCCEEDED' | 'VOID'
  received_at: string
  fee_estimated_pence: number
  fee_actual_pence: number | null
  livemode: boolean | null
  reference: string | null
  notes: string | null
  recorded_by_name: string | null
  needs_review: boolean
  review_note: string | null
  void_reason: string | null
  refunds: PaymentRefund[]
}

export interface SessionDetail {
  session: PitchSession & { venue: Venue | null }
  totals: SessionTotals
  attendees: SessionAttendee[]
  requests: PaymentRequest[] | null
  payments: Payment[] | null
  audit: Array<{ action: string; details: Record<string, unknown>; created_at: string; actor: string | null }> | null
  can: { finance: boolean; sessions: boolean; attendance: boolean; request: boolean; manual: boolean; refund: boolean }
}
