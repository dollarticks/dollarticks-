export async function onRequest(context) {
  const url = new URL(context.request.url);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const page = (message, status = 400) =>
    new Response(
      `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DollarTicks</title>
</head>
<body style="font-family:system-ui;background:#080b10;color:white;padding:30px">
<h2>DollarTicks</h2>
<p>${message}</p>
<p>
<a href="https://dollarticks.pages.dev/" style="color:#18c6d8">
Return to DollarTicks
</a>
</p>
</body>
</html>`,
      {
        status,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );

  if (error) {
    return page(
      "Deriv authorization was cancelled or failed."
    );
  }

  if (!code || !returnedState) {
    return page(
      "Missing authorization code or state."
    );
  }

  const cookies =
    context.request.headers.get("Cookie") || "";

  function getCookie(name) {
    const match = cookies.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]*)")
    );

    return match
      ? decodeURIComponent(match[2])
      : null;
  }

  const savedState =
    getCookie("dt_oauth_state");

  const codeVerifier =
    getCookie("dt_pkce_verifier");

  if (!savedState || !codeVerifier) {
    return page(
      "OAuth session information is missing. Please connect your Deriv account again."
    );
  }

  if (returnedState !== savedState) {
    return page(
      "State verification failed. Please connect your Deriv account again."
    );
  }

  const clientId =
    "347btQbpUS2La9uhcLb2X";

  const redirectUri =
    "https://dollarticks.pages.dev/callback";

  const tokenResponse = await fetch(
    "https://auth.deriv.com/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type:
          "authorization_code",
        client_id:
          clientId,
        code:
          code,
        code_verifier:
          codeVerifier,
        redirect_uri:
          redirectUri
      })
    }
  );

  const tokenData =
    await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    console.error(
      "Deriv OAuth error:",
      tokenData
    );

    return page(
      "Deriv authorization could not be completed. Please try again."
    );
  }

  const accessToken =
    tokenData.access_token;

  console.log(
    "OAuth token received successfully. Token length:",
    accessToken.length
  );

  const tokenCookie =
    `dt_access_token=${encodeURIComponent(accessToken)}; ` +
    `Path=/; ` +
    `Max-Age=3500; ` +
    `Secure; ` +
    `HttpOnly; ` +
    `SameSite=Lax`;

  const stateCookie =
    "dt_oauth_state=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  const verifierCookie =
    "dt_pkce_verifier=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  const headers =
    new Headers();

  headers.set(
    "Location",
    "https://dollarticks.pages.dev/trading"
  );

  headers.append(
    "Set-Cookie",
    tokenCookie
  );

  headers.append(
    "Set-Cookie",
    stateCookie
  );

  headers.append(
    "Set-Cookie",
    verifierCookie
  );

  return new Response(null, {
    status: 303,
    headers
  });
      }
