/* ═══════════════════════════════════════════════════════
   STUDYVAULT — supabase.js
   Supabase client initialization + auth helpers
   
   ⚠️  REPLACE the two values below with your actual
       Supabase Project URL and anon key from:
       Supabase Dashboard → Settings → API
═══════════════════════════════════════════════════════ */

// ── CONFIG ───────────────────────────────────────────
export const SUPABASE_URL  = 'https://klecwqzekmvnnnqlqrjl.supabase.co';
export const SUPABASE_ANON = 'sb_publishable_180Uo-Au1B3HTHp1ARjLhA_kzWEbUAE';

// ── Admin email (only this email gets admin powers) ──
export const ADMIN_EMAIL = 'souriksamanta927@gmail.com';

// ── Init client ──────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ─── AUTH HELPERS ───────────────────────────────────── */

/** Get the current logged-in user (or null) */
export async function getCurrentUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data) return null;
    return data.user || null;
  } catch (err) {
    console.error("Auth error:", err);
    return null;
  }
}

/** Returns true if the current user is the admin */
export async function isAdmin() {
  const user = await getCurrentUser();
  return user?.email === ADMIN_EMAIL;
}

/** Sign in with email + password */
export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

/** Sign up with email + password */
export async function signUp(email, password) {
  return supabase.auth.signUp({ email, password });
}

/** Sign out */
export async function signOut() {
  return supabase.auth.signOut();
}

/** Auth guard — redirects to login.html if not authenticated */
export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = 'login.html';
  }
  return user;
}
