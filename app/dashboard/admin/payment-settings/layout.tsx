import { PitchSessionsGate } from '@/components/feature-gate'

export default function Layout({ children }: { children: React.ReactNode }) {
  return <PitchSessionsGate>{children}</PitchSessionsGate>
}
