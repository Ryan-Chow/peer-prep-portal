// Supabase project settings. The publishable key is a public, RLS-gated
// credential — it is meant to ship to the browser. Never put a secret key here.
window.PPA_CONFIG = {
  // Project root only — supabase-js appends /rest/v1, /auth/v1 and /functions/v1
  // itself, so a path here would produce doubled-up URLs.
  SUPABASE_URL: 'https://zyugzsscxhcmzbxpsglv.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Hj-UMVIRtNI_OJsmxsDXyA_HdFhHZK0',

  // Tutors sign in with a username; it is expanded to an address in this
  // domain before hitting Supabase auth. Must match the Edge Function.
  TUTOR_EMAIL_DOMAIN: 'tutors.peerprepacademy.com'
};
