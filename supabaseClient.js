// The one and only Supabase client.
//
// Two GoTrue clients in one tab share a storage key but not their in-memory
// state, so they race on token refresh and each ignores the other's sign-in.
// dc-runtime re-injects <helmet> scripts into <head>, which made this file's
// predecessor run twice — hence the singleton guard below. Nothing else in the
// app may call createClient(); import this instance instead.
(function () {
  if (window.ppaSupabase) return;

  const cfg = window.PPA_CONFIG || {};

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[ppa] supabase-js must load before supabaseClient.js.');
    return;
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.indexOf('YOUR-PROJECT') >= 0) {
    console.error('[ppa] config.js is missing real Supabase credentials.');
    return;
  }

  window.ppaSupabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Nobody signs in by link any more, but password recovery mails still
      // come back as a token in the URL fragment, and that needs picking up.
      detectSessionInUrl: true,
      storageKey: 'ppa-auth'
    }
  });
})();
