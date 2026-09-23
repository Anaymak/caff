// Kept as a compatibility export for older imports. New code should call the
// factory so configuration errors can be presented as a useful UI state.
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

export const supabase = getSupabaseBrowserClient()
