export async function onRequest(context) {
  const clientId = "347btQbpUS2La9uhcLb2X";
  const redirectUri = "https://dollarticks.pages.dev/callback";

  const randomBytes = crypto.getRandomValues(new Uint8Array(64));
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
    String.fromCharCode(...new Uint8Array(hash))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = Array.from(stateBytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  const authUrl = new URL("https://auth.deriv.com/oauth2/auth");

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "trade");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const cookieOptions =
    "Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax";

const headers = new Headers();
headers.set("Location", authUrl.toString());

headers.append(
  "Set-Cookie",
  `dt_pkce_verifier=${encodeURIComponent(codeVerifier)}; ${cookieOptions}`
);

headers.append(
  "Set-Cookie",
  `dt_oauth_state=${encodeURIComponent(state)}; ${cookieOptions}`
);

return new Response(null, {
  status: 302,
  headers
});
}
