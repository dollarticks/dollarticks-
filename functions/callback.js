export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);

  const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
  const REDIRECT_URI =
    "https://dollarticks.pages.dev/callback";

  const DERIV_API =
    "https://api.derivws.com";

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
          "Content-Type": "text/html",
          "Cache-Control": "no-store"
        }
      }
    );
  }

  function getCookie(name) {
    const cookies =
      request.headers.get("Cookie") || "";

    const parts = cookies.split(";");

    for (const part of parts) {
      const index = part.indexOf("=");

      if (index === -1) continue;

      const key =
        part.slice(0, index).trim();

      const value =
        part.slice(index + 1).trim();

      if (key === name) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }

    return null;
  }

  /*
   * ==========================================
   * READ OAUTH RESPONSE
   * ==========================================
   */

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

  /*
   * ==========================================
   * READ SAVED PKCE DATA
   * ==========================================
   */

  const savedState =
    getCookie("dt_oauth_state");

  const codeVerifier =
    getCookie("dt_pkce_verifier");

  if (!savedState) {
    return html(
      "OAuth state cookie is missing. Please tap Connect Deriv again."
    );
  }

  if (!codeVerifier) {
    return html(
      "PKCE verifier cookie is missing. Please tap Connect Deriv again."
    );
  }

  /*
   * ==========================================
   * VERIFY STATE
   * ==========================================
   */

  if (returnedState !== savedState) {
    return html(
      "OAuth state verification failed. Please connect Deriv again."
    );
  }

  /*
   * ==========================================
   * EXCHANGE CODE FOR ACCESS TOKEN
   * ==========================================
   */

  let tokenResponse;

  try {
    tokenResponse = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "Accept":
            "application/json"
        },

        body: new URLSearchParams({
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
      "Token request failed:",
      error
    );

    return html(
      "Could not contact Deriv's OAuth token service."
    );
  }

  let tokenData;

  try {
    tokenData =
      await tokenResponse.json();
  } catch {
    return html(
      "Deriv returned an invalid OAuth response."
    );
  }

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    console.error(
      "Deriv token exchange failed:",
      tokenData
    );

    return html(
      `Deriv did not issue an access token.<br><br>
       ${tokenData.error || ""}
       ${tokenData.error_description || ""}`
    );
  }

  const accessToken =
    tokenData.access_token;

  /*
   * ==========================================
   * IMPORTANT:
   * TEST THE TOKEN BEFORE SAVING IT
   * ==========================================
   */

  let accountResponse;

  try {
    accountResponse = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",

        headers: {
          "Authorization":
            `Bearer ${accessToken}`,

          "Deriv-App-ID":
            CLIENT_ID,

          "Accept":
            "application/json"
        },

        cache: "no-store"
      }
    );
  } catch (error) {
    console.error(
      "Options account request failed:",
      error
    );

    return html(
      "The OAuth login succeeded, but DollarTicks could not contact Deriv Options."
    );
  }

  let accountData;

  try {
    accountData =
      await accountResponse.json();
  } catch {
    return html(
      "Deriv returned an invalid Options account response."
    );
  }

  /*
   * If this fails, the problem is NOT the cookie.
   * It means the OAuth token itself does not have
   * access to the Options API.
   */

  if (!accountResponse.ok) {
    console.error(
      "Options account API rejected token:",
      accountData
    );

    const message =
      accountData.errors?.[0]?.message ||
      accountData.error?.message ||
      "Deriv rejected the authenticated Options request.";

    return html(
      `Login succeeded, but Deriv rejected the Options account request.<br><br>
       <b>${message}</b>`
    );
  }

  /*
   * ==========================================
   * FIND OPTIONS ACCOUNTS
   * ==========================================
   */

  function findAccounts(value) {
    const result = [];

    function scan(item) {
      if (!item) return;

      if (Array.isArray(item)) {
        for (const child of item) {
          scan(child);
        }
        return;
      }

      if (
        typeof item !== "object"
      ) {
        return;
      }

      if (
        item.account_id ||
        item.loginid ||
        item.id
      ) {
        result.push(item);
      }

      for (
        const value of Object.values(item)
      ) {
        if (
          value &&
          typeof value === "object"
        ) {
          scan(value);
        }
      }
    }

    scan(value);

    const seen =
      new Set();

    return result.filter(account => {

      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) {
        return false;
      }

      const key =
        String(id);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
  }

  const accounts =
    findAccounts(accountData);

  console.log(
    "DollarTicks Options accounts:",
    accounts.map(account => ({
      account_id:
        account.account_id ||
        account.id ||
        null,

      loginid:
        account.loginid ||
        null,

      account_type:
        account.account_type ||
        null,

      currency:
        account.currency ||
        null
    }))
  );

  if (!accounts.length) {
    return html(
      "Deriv login succeeded, but Deriv returned no Options accounts."
    );
  }

  /*
   * ==========================================
   * SAVE ACCESS TOKEN
   * ==========================================
   */

  const tokenCookie =
    `dt_access_token=${encodeURIComponent(accessToken)}; ` +
    `Path=/; ` +
    `Max-Age=3500; ` +
    `Secure; ` +
    `HttpOnly; ` +
    `SameSite=Lax`;

  const expiredStateCookie =
    "dt_oauth_state=; " +
    "Path=/; " +
    "Max-Age=0; " +
    "Secure; " +
    "HttpOnly; " +
    "SameSite=Lax";

  const expiredVerifierCookie =
    "dt_pkce_verifier=; " +
    "Path=/; " +
    "Max-Age=0; " +
    "Secure; " +
    "HttpOnly; " +
    "SameSite=Lax";

  const headers =
    new Headers();

  headers.set(
    "Location",
    "https://dollarticks.pages.dev/"
  );

  headers.set(
    "Cache-Control",
    "no-store"
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

  /*
   * ==========================================
   * SUCCESS
   * ==========================================
   */

  return new Response(null, {
    status: 303,
    headers
  });
    }
