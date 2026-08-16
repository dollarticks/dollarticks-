export async function onRequest(context) {
  const url = new URL(context.request.url);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const html = (title, message) => `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${title}</title>
      </head>
      <body style="font-family:system-ui;padding:30px;background:#080b10;color:white">
        <h2>DollarTicks</h2>
        <p>${message}</p>
        <p>
          <a href="https://dollarticks.pages.dev/"
             style="color:#18c6d8">
            Return to DollarTicks
          </a>
        </p>
      </body>
    </html>
  `;

  if (error) {
    return new Response(
      html(
        "DollarTicks",
        "Deriv authorization was cancelled or failed."
      ),
      {
        status: 400,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  }

  if (!code || !returnedState) {
    return new Response(
      html(
        "DollarTicks",
        "Missing authorization code or state."
      ),
      {
        status: 400,
        headers: {
          "Content-Type": "text/html"
        }
      }
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
    return new Response(
      html(
        "DollarTicks",
        "OAuth session information is missing. Please connect again."
      ),
      {
        status: 400,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  }

  if (returnedState !== savedState) {
    return new Response(
      html(
        "DollarTicks",
        "State verification failed. Please connect again."
      ),
      {
        status: 400,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  }

  const clientId =
    "347btQbpUS2La9uhcLb2X";

  const redirectUri =
    "https://dollarticks.pages.dev/callback";

  const tokenResponse =
    await fetch(
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
      "OAuth token error:",
      tokenData
    );

    return new Response(
      html(
        "DollarTicks",
        "Deriv authorization could not be completed. Please try again."
      ),
      {
        status: 400,
        headers: {
          "Content-Type": "text/html"
        }
      }
    );
  }

  /*
   * Save the OAuth access token in a secure,
   * HttpOnly cookie so the trading endpoint
   * can authenticate with Deriv.
   */

  const accessToken =
    tokenData.access_token;

  const tokenCookie =
    `dt_access_token=${encodeURIComponent(accessToken)}; ` +
    `Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`;

  const stateCookie =
    "dt_oauth_state=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  const verifierCookie =
    "dt_pkce_verifier=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  const headers =
    new Headers();

  headers.set(
    "Content-Type",
    "text/html"
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

  return new Response(
    html(
      "DollarTicks",
      "Deriv account connected successfully."
    ),
    {
      status: 200,
      headers
    }
  );
          }
