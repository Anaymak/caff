const labels: Record<string, string> = {
  PLAYING: 'Playing', WATCHING: 'Watching', MAYBE: 'Maybe', NOT_ATTENDING: "Can't make it",
  AVAILABILITY_OPEN: 'Availability open', TEAMS_GENERATED: 'Teams ready', VOTING_OPEN: 'Voting open',
  FINALISED: 'Final', CANCELLED: 'Cancelled', DRAFT: 'Draft', PLAYED: 'Played',
  PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended',
  WAITING: 'Waiting list',
  PLANNING: 'Planning', OPEN: 'Open', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', UNCONFIRMED: 'Not confirmed',
  FAILED: 'Failed', PAID: 'Paid', MANUALLY_PAID: 'Paid manually', REFUNDED: 'Refunded', SUPERSEDED: 'Replaced',
  SUCCEEDED: 'Received', VOID: 'Void',
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status.toLowerCase().replace(/\s+/g, '_')}`}>{labels[status] ?? status}</span>
}
