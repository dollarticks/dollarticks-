const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const REDIRECT_URI = "https://dollarticks.pages.dev/callback";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   HTML RESPONSE
===================================================== */

function html(message, status = 400) {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DollarTicks</title>
</head>

<body style="
font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background:#080b10;
color:white;
padding:30px;
">

<div style="
max-width:500px;
margin:40px auto;
background:#10151d;
border:1px solid #202733;
border-radius:18px;
padding:25px;
">

<h2 style="margin-top:0">
Dollar<span style="color:#18c6d8">Ticks</span>
</h2>

<p style="line-height:1.6">
${message}
</p>

<p>
<a
href="https://dollarticks.pages.dev/"
style="color:#18c6d8;text-decoration:none"
>
Return to DollarTicks
</a>
</p>

</div>

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

/* =====================================================
   COOKIE READER
===================================================== */

function getCookie(request, name) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part.slice(0, index).trim();

    if (key !== name) {
      continue;
    }

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

/* =====================================================
   MAIN CALLBACK
===================================================== */

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);

  /* ===================================================
     ONLY GET ALLOWED
  =================================================== */

  if (request.method !== "GET") {
    return html(
      "Invalid callback request.",
      405
    );
  }

  /* ===================================================
     OAUTH PARAMETERS
  =================================================== */

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

  /* ===================================================
     DERIV ERROR
  =================================================== */

  if (oauthError) {
    return html(
      `Deriv authorization was not completed.<br><br>
       <b>Error:</b> ${oauthError}<br>
       ${
         oauthErrorDescription || ""
       }`
    );
  }

  /* ===================================================
     CHECK CODE
  =================================================== */

  if (!code) {
    return html(
      "No authorization code was returned by Deriv."
    );
  }

  /* ===================================================
     CHECK STATE
  =================================================== */

  if (!returnedState) {
    return html(
      "No OAuth state was returned by Deriv."
    );
  }

  /* ===================================================
     READ PKCE COOKIES
  =================================================== */

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
      "Your login session expired. Please return to DollarTicks and connect again."
    );
  }

  if (!codeVerifier) {
    return html(
      "The secure login verifier is missing. Please return to DollarTicks and connect again."
    );
  }

  /* ===================================================
     VERIFY STATE
  =================================================== */

  if (returnedState !== savedState) {
    return html(
      "OAuth security verification failed. Please start the connection again."
    );
  }

  /* ===================================================
     EXCHANGE AUTHORIZATION CODE
  =================================================== */

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
      "DollarTicks OAuth token request error:",
      error
    );

    return html(
      "DollarTicks could not contact Deriv authorization. Please try again."
    );
  }

  /* ===================================================
     READ TOKEN RESPONSE
  =================================================== */

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
      "DollarTicks OAuth TOKEN ERROR:",
      tokenData
    );

    return html(
      `Authorization failed.<br><br>
       ${
         tokenData?.error ||
         "Unknown authorization error."
       }<br>
       ${
         tokenData?.error_description ||
         ""
       }`
    );
  }

  const accessToken =
    tokenData.access_token;

  /* ===================================================
     VERIFY THAT A TRADING ACCOUNT EXISTS
  =================================================== */

  let accountResponse;

  try {
    accountResponse = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Deriv-App-ID":
            CLIENT_ID,

          Accept:
            "application/json"
        },

        cache:
          "no-store"
      }
    );
  } catch (error) {
    console.error(
      "DollarTicks account request error:",
      error
    );

    return html(
      "Login succeeded, but DollarTicks could not reach the Deriv trading account."
    );
  }

  /* ===================================================
     READ ACCOUNT RESPONSE
  =================================================== */

  let accountData;

  try {
    accountData =
      await accountResponse.json();
  } catch {
    return html(
      "Deriv returned an invalid trading-account response."
    );
  }

  if (!accountResponse.ok) {
    console.error(
      "DollarTicks ACCOUNT ERROR:",
      accountData
    );

    const message =
      accountData?.errors?.[0]?.message ||
      accountData?.error?.message ||
      accountData?.message ||
      "The Deriv trading account could not be accessed.";

    return html(
      `Login succeeded, but the trading account could not be accessed.<br><br>
       <b>${message}</b>`
    );
  }

  /* ===================================================
     FIND ACCOUNT
  =================================================== */

  function findAccounts(value) {
    const result = [];

    function scan(item) {
      if (!item) {
        return;
      }

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
        const child of Object.values(item)
      ) {
        if (
          child &&
          typeof child === "object"
        ) {
          scan(child);
        }
      }
    }

    scan(value);

    const seen = new Set();

    return result.filter(account => {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) {
        return false;
      }

      const key = String(id);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
  }

  const accounts =
    findAccounts(accountData);

  if (!accounts.length) {
    return html(
      "Login succeeded, but no Deriv trading account was returned."
    );
  }

  /* ===================================================
     SELECT DEFAULT ACCOUNT
  =================================================== */

  const demoAccount =
    accounts.find(
      account =>
        String(
          account.account_type || ""
        ).toLowerCase() === "demo"
    );

  const selectedAccount =
    demoAccount ||
    accounts[0];

  const accountId =
    selectedAccount.account_id ||
    selectedAccount.loginid ||
    selectedAccount.id ||
    null;

  const accountType =
    String(
      selectedAccount.account_type ||
      "demo"
    ).toLowerCase();

  const currency =
    selectedAccount.currency ||
    "USD";

  if (!accountId) {
    return html(
      "Deriv returned an incomplete trading-account record."
    );
  }

  console.log(
    "DollarTicks authenticated account:",
    {
      account_id: accountId,
      account_type: accountType,
      currency: currency
    }
  );

  /* ===================================================
     SAVE ACCESS TOKEN
  =================================================== */

  const tokenCookie =
    "dt_access_token=" +
    encodeURIComponent(accessToken) +
    "; Path=/" +
    "; Max-Age=3500" +
    "; Secure" +
    "; HttpOnly" +
    "; SameSite=Lax";

  /* ===================================================
     EXPIRE OAUTH STATE
  =================================================== */

  const expiredStateCookie =
    "dt_oauth_state=;" +
    " Path=/;" +
    " Max-Age=0;" +
    " Secure;" +
    " HttpOnly;" +
    " SameSite=Lax";

  /* ===================================================
     EXPIRE PKCE VERIFIER
  =================================================== */

  const expiredVerifierCookie =
    "dt_pkce_verifier=;" +
    " Path=/;" +
    " Max-Age=0;" +
    " Secure;" +
    " HttpOnly;" +
    " SameSite=Lax";

  /* ===================================================
     REDIRECT TO DASHBOARD
  =================================================== */

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

  /* ===================================================
     IMPORTANT:
     KEEP EACH COOKIE SEPARATE
  =================================================== */

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

  /* ===================================================
     SUCCESS
  =================================================== */

  return new Response(null, {
    status: 303,
    headers
  });
      }
