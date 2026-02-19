'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export default function Home() {
  useEffect(() => {
    async function testConnection() {
      const { data, error } = await supabase.from('profiles').select('*')
      console.log('Supabase data:', data)
      console.log('Supabase error:', error)
    }
    testConnection()
  }, [])

  return (
    <div className="p-10 text-xl">
      Testing Supabase connection… open your browser console
    </div>
  )
}
