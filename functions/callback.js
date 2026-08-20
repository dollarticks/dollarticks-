const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const REDIRECT_URI = "https://dollarticks.pages.dev/callback";

function html(message, status = 400) {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DollarTicks</title>
</head>

<body style="
font-family:system-ui;
background:#080b10;
color:white;
padding:30px;
">

<h2>DollarTicks</h2>

<p>${message}</p>

<p>
<a
href="https://dollarticks.pages.dev/"
style="color:#18c6d8"
>
Return to DollarTicks
</a>
</p>

</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

function getCookie(request, name) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key =
      part.slice(0, index).trim();

    if (key !== name) continue;

    const value =
      part.slice(index + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export async function onRequest(context) {

  const request = context.request;
  const url = new URL(request.url);

  /* =====================================================
     OAUTH RESPONSE
  ===================================================== */

  const code =
    url.searchParams.get("code");

  const returnedState =
    url.searchParams.get("state");

  const oauthError =
    url.searchParams.get("error");

  const oauthErrorDescription =
    url.searchParams.get(
      "error_description"
    );

  if (oauthError) {
    return html(
      `Deriv authorization failed.<br><br>
       Error: ${oauthError}<br>
       ${oauthErrorDescription || ""}`
    );
  }

  if (!code) {
    return html(
      "No authorization code was returned by Deriv."
    );
  }

  if (!returnedState) {
    return html(
      "No OAuth state was returned by Deriv."
    );
  }

  /* =====================================================
     READ PKCE COOKIES
  ===================================================== */

  const savedState =
    getCookie(
      request,
      "dt_oauth_state"
    );

  const codeVerifier =
    getCookie(
      request,
      "dt_pkce_verifier"
    );

  if (!savedState) {
    return html(
      "OAuth state cookie is missing. Please start the connection again."
    );
  }

  if (!codeVerifier) {
    return html(
      "PKCE verifier cookie is missing. Please start the connection again."
    );
  }

  /* =====================================================
     VERIFY STATE
  ===================================================== */

  if (returnedState !== savedState) {
    return html(
      "OAuth state verification failed. Please start the connection again."
    );
  }

  /* =====================================================
     EXCHANGE AUTHORIZATION CODE
  ===================================================== */

  let tokenResponse;

  try {

    tokenResponse =
      await fetch(
        "https://auth.deriv.com/oauth2/token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
            "Accept":
              "application/json"
          },

          body:
            new URLSearchParams({
              grant_type:
                "authorization_code",

              client_id:
                CLIENT_ID,

              code:
                code,

              code_verifier:
                codeVerifier,

              redirect_uri:
                REDIRECT_URI
            })
        }
      );

  } catch (error) {

    console.error(
      "DollarTicks OAuth error:",
      error
    );

    return html(
      "Could not contact the Deriv authorization service."
    );
  }

  /* =====================================================
     READ TOKEN RESPONSE
  ===================================================== */

  let tokenData;

  try {

    tokenData =
      await tokenResponse.json();

  } catch {

    return html(
      "Deriv returned an invalid authorization response."
    );
  }

  if (
    !tokenResponse.ok ||
    !tokenData?.access_token
  ) {

    console.error(
      "DollarTicks TOKEN ERROR:",
      tokenData
    );

    return html(
      `Authorization failed.<br><br>
       ${tokenData?.error || ""}<br>
       ${tokenData?.error_description || ""}`
    );
  }

  const accessToken =
    tokenData.access_token;

  /* =====================================================
     SAVE TOKEN
  ===================================================== */

  const tokenCookie =
    [
      `dt_access_token=${encodeURIComponent(
        accessToken
      )}`,
      "Path=/",
      "Max-Age=3500",
      "Secure",
      "HttpOnly",
      "SameSite=Lax"
    ].join("; ");

  /* =====================================================
     CLEAR OAUTH COOKIES
  ===================================================== */

  const expiredStateCookie =
    [
      "dt_oauth_state=",
      "Path=/",
      "Max-Age=0",
      "Secure",
      "HttpOnly",
      "SameSite=Lax"
    ].join("; ");

  const expiredVerifierCookie =
    [
      "dt_pkce_verifier=",
      "Path=/",
      "Max-Age=0",
      "Secure",
      "HttpOnly",
      "SameSite=Lax"
    ].join("; ");

  /* =====================================================
     REDIRECT
  ===================================================== */

  const headers =
    new Headers();

  headers.set(
    "Location",
    "https://dollarticks.pages.dev/"
  );

  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  headers.append(
    "Set-Cookie",
    tokenCookie
  );

  headers.append(
    "Set-Cookie",
    expiredStateCookie
  );

  headers.append(
    "Set-Cookie",
    expiredVerifierCookie
  );

  return new Response(
    null,
    {
      status: 303,
      headers
    }
  );
      }
