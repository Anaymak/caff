import Link from 'next/link'

export const metadata = { title: 'Privacy' }

export default function PrivacyPage() {
  return <main className="legal-page">
    <Link href="/auth" className="text-button">← CAFF</Link>
    <p className="eyebrow">YOUR DATA</p>
    <h1>Privacy at CAFF</h1>
    <p>CAFF is a football organiser for one local group. This is a plain-language draft of how the app uses your information. Ask the group owner if you have questions.</p>
    <h2>What we keep</h2>
    <p>Your account email, name, optional photo and profile details, availability, team assignments, results, goals, ratings, votes and match comments. We use these to run games and show football records.</p>
    <h2>Who sees it</h2>
    <p>Approved members can see football profiles, attendance, teams and published results. Other players do not see your email. Pending accounts cannot see club data. Admins see account emails and private audit information so they can approve accounts and handle problems.</p>
    <h2>Anonymous contributions</h2>
    <p>Other players cannot see who submitted an anonymous comment or vote. Admins can identify contributors for moderation and to prevent duplicate votes. Published ratings are aggregated and need at least three eligible ratings.</p>
    <h2>Photos and storage</h2>
    <p>Profile photos are optional. They are stored in the club’s Supabase Storage bucket and may be accessible to someone with the photo URL, so please upload only a photo you are comfortable sharing.</p>
    <h2>Account removal</h2>
    <p>Request account removal from the Help section after signing in, or ask the group owner. An admin will review the request and explain how your account and historical match records will be handled before removal. This process is currently manual. Suspension is different: it blocks access but keeps the account for possible reinstatement.</p>
    <h2>Cookies and contact</h2>
    <p>CAFF uses essential authentication storage to keep you signed in. The app does not currently include advertising or analytics trackers. Speak to a CAFF admin in the group about privacy or deletion requests.</p>
    <p className="muted">Last updated 24 September 2026. This page is a working privacy notice, not a claim of legal certification.</p>
  </main>
}
