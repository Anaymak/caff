'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function AuthPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [message, setMessage] = useState('')

  // -------------------------
  // SIGN UP
  // -------------------------
  async function signUp() {
    // 1️⃣ Create the user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    })
    if (authError) {
      setMessage(authError.message)
      return
    }

    setMessage('Signed up! Check your email to confirm.')

    // 2️⃣ Upload avatar if provided
    let avatarUrl = null
    if (avatarFile) {
      const fileExt = avatarFile.name.split('.').pop()
      const fileName = `${Date.now()}.${fileExt}` // unique file name
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, avatarFile)
      if (uploadError) {
        setMessage(uploadError.message)
        return
      }

      // 3️⃣ Build public URL
      avatarUrl = `https://ptlxalknnvvoksxopcmj.supabase.co/storage/v1/object/public/avatars/${fileName}`
    }

    // 4️⃣ Insert profile row
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .insert([
        { email, avatar_url: avatarUrl }
      ])
    if (profileError) setMessage(profileError.message)
  }

  // -------------------------
  // SIGN IN
  // -------------------------
  async function signIn() {
    // Sign in the user
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
  
    if (error) {
      setMessage(error.message)
      return
    }
  
    // ✅ Make sure session is set
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) {
      setMessage(sessionError.message)
      return
    }
  
    if (sessionData.session) {
      setMessage('Logged in successfully! Redirecting...')
      router.push('/dashboard') // Redirect to dashboard
    } else {
      setMessage('Login failed. No session found.')
    }
  }
  

  // -------------------------
  // JSX
  // -------------------------
  return (
    <div className="p-10 max-w-md mx-auto">
      <h1 className="text-2xl mb-4">CAFF Login / Signup</h1>

      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="border p-2 w-full mb-2"
      />

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="border p-2 w-full mb-2"
      />

      <input
        type="file"
        onChange={(e) => setAvatarFile(e.target.files ? e.target.files[0] : null)}
        className="border p-2 w-full mb-2"
      />

      <button onClick={signUp} className="bg-blue-500 text-white p-2 mr-2">
        Sign Up
      </button>
      <button onClick={signIn} className="bg-green-500 text-white p-2">
        Log In
      </button>

      <p className="mt-4 text-red-500">{message}</p>
    </div>
  )
}
