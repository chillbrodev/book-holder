/**
 * Sign-in, sign-up and sign-out, against Supabase directly.
 *
 * There is no `/auth/register` or `/auth/login` on our API any more, and this
 * file no longer speaks to it at all. The browser holds the credential
 * relationship with Supabase; our API only ever sees the resulting token.
 *
 * What is left here is the translation layer: Supabase's `{ data, error }`
 * returns become thrown `AuthApiError`s with messages an actor can act on,
 * because `AuthModal` renders whatever it catches straight into the panel and
 * "Invalid login credentials" is not something to put in front of someone who
 * has just mistyped a password.
 */
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

export interface AuthUser {
  id: string
  email: string
  name: string
}

export class AuthApiError extends Error {
  readonly name: string

  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** What the header greets her by. Mirrors the API's `displayName` (see
 * api/src/features/auth/supabaseJwt.ts) so "Hi, …" says the same thing before
 * and after a round trip — the two derive it from the same claims, and it would
 * be visible if they disagreed. */
function displayName(user: User): string {
  const metadata = user.user_metadata as { name?: string; full_name?: string } | undefined
  const fromMetadata = metadata?.name?.trim() || metadata?.full_name?.trim()
  if (fromMetadata) return fromMetadata

  return user.email?.split('@')[0]?.trim() || 'Actor'
}

export function toAuthUser(user: User): AuthUser {
  return { id: user.id, email: user.email ?? '', name: displayName(user) }
}

/**
 * Supabase's error messages, in this app's voice.
 *
 * Only the cases an actor can actually do something about are rewritten; the
 * rest fall through with Supabase's own text, which is better than a generic
 * "something went wrong" that hides a real cause (rate limiting, a project
 * misconfiguration, a network failure).
 */
function toAuthApiError(error: { message: string; code?: string }): AuthApiError {
  const message = error.message.toLowerCase()

  if (message.includes('invalid login credentials')) {
    return new AuthApiError('INVALID_CREDENTIALS', "That email and password don't match. Try again.")
  }
  if (message.includes('already registered') || error.code === 'user_already_exists') {
    return new AuthApiError('EMAIL_TAKEN', 'There is already an account with that email. Log in instead.')
  }
  if (message.includes('email not confirmed')) {
    return new AuthApiError(
      'EMAIL_NOT_CONFIRMED',
      'Check your inbox and confirm your email first, then log in.',
    )
  }
  if (message.includes('password')) {
    // Length and complexity rules are set in the Supabase project, not here, so
    // its own wording is the accurate one — repeating a rule in this file is
    // how the message and the rule drift apart.
    return new AuthApiError('WEAK_PASSWORD', error.message)
  }

  return new AuthApiError('AUTH_ERROR', error.message)
}

/**
 * Create the account.
 *
 * Returns whether she is signed in *now*. With email confirmation enabled in
 * the Supabase project, sign-up succeeds but returns no session: the account
 * exists and is waiting on a link in her inbox. That is a success the UI has to
 * be able to tell apart from being signed in, or it closes the modal on someone
 * who is still a guest.
 */
export async function register(input: {
  email: string
  password: string
}): Promise<{ signedIn: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
  })
  if (error) throw toAuthApiError(error)
  return { signedIn: data.session !== null }
}

export async function login(input: { email: string; password: string }): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  })
  if (error) throw toAuthApiError(error)
}

export async function logout(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error) throw toAuthApiError(error)
}

/** The session Supabase currently holds, if any. Local — it does not ask the
 * server who she is, which is the point: the token itself carries that, and our
 * API re-verifies it on every call. */
export async function getCurrentSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession()
  return data.session
}
