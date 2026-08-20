const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const REDIRECT_URI = "https://dollarticks.pages.dev/callback";

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);

  /* =====================================================
     LOGIN / SIGNUP
  ===================================================== */

  const mode = url.searchParams.get("mode");
  const isSignup = mode === "signup";

  /* =====================================================
     CREATE PKCE VERIFIER
  ===================================================== */

  const randomBytes = crypto.getRandomValues(
    new Uint8Array(64)
  );

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

  const codeVerifier = Array.from(randomBytes)
    .map(byte => alphabet[byte % alphabet.length])
    .join("");

  /* =====================================================
     CREATE CODE CHALLENGE
  ===================================================== */

  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );

  const codeChallenge = btoa(
    String.fromCharCode(...new Uint8Array(hash))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  /* =====================================================
     CREATE OAUTH STATE
  ===================================================== */

  const stateBytes = crypto.getRandomValues(
    new Uint8Array(32)
  );

  const state = Array.from(stateBytes)
    .map(byte =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");

  /* =====================================================
     DERIV OAUTH URL
  ===================================================== */

  const authUrl = new URL(
    "https://auth.deriv.com/oauth2/auth"
  );

  authUrl.searchParams.set(
    "response_type",
    "code"
  );

  authUrl.searchParams.set(
    "client_id",
    CLIENT_ID
  );

  authUrl.searchParams.set(
    "redirect_uri",
    REDIRECT_URI
  );

  authUrl.searchParams.set(
    "scope",
    "trade"
  );

  authUrl.searchParams.set(
    "state",
    state
  );

  authUrl.searchParams.set(
    "code_challenge",
    codeChallenge
  );

  authUrl.searchParams.set(
    "code_challenge_method",
    "S256"
  );

  /* =====================================================
     SIGNUP MODE
  ===================================================== */

  if (isSignup) {
    authUrl.searchParams.set(
      "prompt",
      "registration"
    );
  }

  /* =====================================================
     OAUTH COOKIES
  ===================================================== */

  const cookieOptions =
    "Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax";

  const headers = new Headers();

  headers.set(
    "Location",
    authUrl.toString()
  );

  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  /* =====================================================
     SAVE PKCE VERIFIER
  ===================================================== */

  headers.append(
    "Set-Cookie",
    `dt_pkce_verifier=${encodeURIComponent(
      codeVerifier
    )}; ${cookieOptions}`
  );

  /* =====================================================
     SAVE OAUTH STATE
  ===================================================== */

  headers.append(
    "Set-Cookie",
    `dt_oauth_state=${encodeURIComponent(
      state
    )}; ${cookieOptions}`
  );

  /* =====================================================
     REDIRECT
  ===================================================== */

  return new Response(null, {
    status: 302,
    headers
  });
}
