// Build-time switch for pitch sessions and payments. Leave unset until migration
// 202610250001 is applied; then build with NEXT_PUBLIC_PITCH_SESSIONS=on.
// Card payments additionally need the payments API behind /api (see README).
export const PITCH_SESSIONS_ENABLED = process.env.NEXT_PUBLIC_PITCH_SESSIONS === 'on'
