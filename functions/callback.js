export async function onRequest(context) {
  const url = new URL(context.request.url);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<h2>DollarTicks</h2><p>Deriv authorization was cancelled or failed.</p>`,
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  if (!code || !returnedState) {
    return new Response(
      "<h2>DollarTicks</h2><p>Missing authorization code or state.</p>",
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  const cookies = context.request.headers.get("Cookie") || "";

  const getCookie = (name) => {
    const match = cookies.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[2]) : null;
  };

  const savedState = getCookie("dt_oauth_state");
  const codeVerifier = getCookie("dt_pkce_verifier");

  if (!savedState || !codeVerifier) {
    return new Response(
      "<h2>DollarTicks</h2><p>OAuth session information is missing.</p>",
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  if (returnedState !== savedState) {
    return new Response(
      "<h2>DollarTicks</h2><p>State verification failed.</p>",
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  const clientId = "347btQbpUS2La9uhcLb2X";
  const redirectUri = "https://dollarticks.pages.dev/callback";

  const tokenResponse = await fetch(
    "https://auth.deriv.com/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      })
    }
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    return new Response(
      `<h2>DollarTicks</h2>
       <p>Deriv authorization could not be completed.</p>
       <p>Please try again.</p>`,
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  return new Response(
    `<html>
      <head><title>DollarTicks</title></head>
      <body>
        <h2>DollarTicks</h2>
        <p>Deriv account connected successfully.</p>
        <p>You can return to DollarTicks.</p>
      </body>
    </html>`,
    {
      headers: {
        "Content-Type": "text/html",
        "Set-Cookie":
          "dt_oauth_state=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
      }
    }
  );
          }
