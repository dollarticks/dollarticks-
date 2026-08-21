const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const REDIRECT_URI = "https://dollarticks.pages.dev/callback";

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);

    const mode = url.searchParams.get("mode");
    const isSignup = mode === "signup";

    /* =====================================================
       PKCE
    ===================================================== */

    const randomBytes = crypto.getRandomValues(
      new Uint8Array(64)
    );

    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    const codeVerifier = Array.from(randomBytes)
      .map(byte => alphabet[byte % alphabet.length])
      .join("");

    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier)
    );

    const codeChallenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(hash)
      )
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    /* =====================================================
       STATE
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
       DERIV OAUTH
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

    /*
     * DollarTicks permissions:
     *
     * trade   = trading operations
     * payment = wallet/payment operations
     *
     * The payment scope is required for
     * authenticated payment functionality.
     */

    authUrl.searchParams.set(
      "scope",
      "trade payment"
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
       SIGN UP
    ===================================================== */

    if (isSignup) {
      authUrl.searchParams.set(
        "prompt",
        "registration"
      );
    }

    /* =====================================================
       COOKIES
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

    headers.append(
      "Set-Cookie",
      `dt_pkce_verifier=${encodeURIComponent(
        codeVerifier
      )}; ${cookieOptions}`
    );

    headers.append(
      "Set-Cookie",
      `dt_oauth_state=${encodeURIComponent(
        state
      )}; ${cookieOptions}`
    );

    return new Response(null, {
      status: 302,
      headers
    });

  } catch (error) {

    console.error(
      "DollarTicks OAuth error:",
      error
    );

    return new Response(
      "DollarTicks authentication error: " +
      (error?.message || "Unknown error"),
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store"
        }
      }
    );
  }
}
