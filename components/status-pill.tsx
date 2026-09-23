const labels: Record<string, string> = {
  PLAYING: 'Playing', WATCHING: 'Watching', MAYBE: 'Maybe', NOT_ATTENDING: "Can't make it",
  AVAILABILITY_OPEN: 'Availability open', TEAMS_GENERATED: 'Teams ready', VOTING_OPEN: 'Voting open',
  FINALISED: 'Final', CANCELLED: 'Cancelled', DRAFT: 'Draft', PLAYED: 'Played',
  PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended',
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status.toLowerCase()}`}>{labels[status] ?? status}</span>
}

