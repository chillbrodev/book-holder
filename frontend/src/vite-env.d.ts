/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  /** Optional in the type, required at runtime — auth/supabaseClient.ts throws
   * on load without them. Declared this way on purpose: marking them required
   * here would only make TypeScript believe a build-time substitution happened,
   * which is exactly the thing that goes missing in a deployed environment. */
  readonly VITE_SUPABASE_URL?: string
  /** The *publishable* key, never the secret one. It is compiled into the
   * bundle and served to every visitor; Supabase's row-level security is what
   * makes that safe, and a `sb_secret_…` key here would hand every visitor
   * admin over the project. */
  readonly VITE_SUPABASE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
