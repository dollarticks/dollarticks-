const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

function getCookie(request, name) {
  const cookies =
    request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key =
      part.slice(0, index).trim();

    if (key !== name) continue;

    try {
      return decodeURIComponent(
        part.slice(index + 1).trim()
      );
    } catch {
      return part.slice(index + 1).trim();
    }
  }

  return null;
}

function findAccounts(value) {
  const accounts = [];

  function scan(item) {
    if (!item) return;

    if (Array.isArray(item)) {
      item.forEach(scan);
      return;
    }

    if (typeof item !== "object") return;

    if (
      item.account_id ||
      item.loginid ||
      item.id
    ) {
      accounts.push(item);
    }

    Object.values(item).forEach(child => {
      if (
        child &&
        typeof child === "object"
      ) {
        scan(child);
      }
    });
  }

  scan(value);

  const seen = new Set();

  return accounts.filter(account => {
    const id =
      account.account_id ||
      account.loginid ||
      account.id;

    if (!id) return false;

    const key = String(id);

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

async function getAccounts(token) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts`,
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Deriv-App-ID": CLIENT_ID,
        "Accept": "application/json"
      },
      cache: "no-store"
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not retrieve accounts."
    );
  }

  return findAccounts(data);
}

async function getOTP(token, accountId) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Deriv-App-ID": CLIENT_ID,
        "Accept": "application/json"
      },
      cache: "no-store"
    }
  );

  const data = await response.json();

  return {
    httpStatus: response.status,
    ok: response.ok,
    hasUrl: !!data?.data?.url,
    url: data?.data?.url || null,
    raw: data
  };
}

export async function onRequest(context) {

  const request =
    context.request;

  const url =
    new URL(request.url);

  const token =
    getCookie(
      request,
      "dt_access_token"
    );

  if (!token) {
    return json(
      {
        ok: false,
        connected: false,
        error:
          "Deriv account is not connected."
      },
      401
    );
  }

  let accounts;

  try {
    accounts =
      await getAccounts(token);
  } catch (error) {
    return json(
      {
        ok: false,
        connected: false,
        error:
          error.message
      },
      401
    );
  }

  if (!accounts.length) {
    return json({
      ok: false,
      connected: false,
      error:
        "No Options account found."
    });
  }

  const selected =
    accounts.find(account =>
      String(
        account.account_type || ""
      ).toLowerCase() === "demo"
    ) ||

    accounts.find(account =>
      String(
        account.account_id ||
        account.id ||
        ""
      )
        .toUpperCase()
        .startsWith("DOT")
    ) ||

    accounts[0];

  const accountId =
    selected.account_id ||
    selected.id ||
    selected.loginid;

  /*
   * NORMAL ACCOUNT CHECK
   */

  if (
    request.method === "GET" &&
    url.searchParams.get("diagnostic") !== "1"
  ) {

    return json({
      ok: true,

      connected: true,

      selected_account: {
        account_id:
          accountId,

        account_type:
          selected.account_type ||
          "demo",

        currency:
          selected.currency ||
          "USD"
      }
    });
  }

  /*
   * OTP / WEBSOCKET DIAGNOSTIC
   */

  if (
    url.searchParams.get("diagnostic") === "1"
  ) {

    let otp;

    try {

      otp =
        await getOTP(
          token,
          accountId
        );

    } catch (error) {

      return json(
        {
          ok: false,

          diagnostic:
            "otp",

          market:
            "1HZ100V",

          account: {
            account_id:
              accountId,

            account_type:
              selected.account_type ||
              "demo",

            currency:
              selected.currency ||
              "USD"
          },

          error:
            error.message
        },
        502
      );
    }

    /*
     * DO NOT expose the actual WebSocket URL.
     * We only report whether Deriv returned one.
     */

    if (!otp.ok || !otp.hasUrl) {

      return json(
        {
          ok: false,

          diagnostic:
            "otp",

          market:
            "1HZ100V",

          account: {
            account_id:
              accountId,

            account_type:
              selected.account_type ||
              "demo",

            currency:
              selected.currency ||
              "USD"
          },

          otp_http_status:
            otp.httpStatus,

          websocket_url_received:
            false,

          deriv_response:
            otp.raw
        },
        502
      );
    }

    return json({
      ok: true,

      diagnostic:
        "otp",

      market:
        "1HZ100V",

      account: {
        account_id:
          accountId,

        account_type:
          selected.account_type ||
          "demo",

        currency:
          selected.currency ||
          "USD"
      },

      otp_http_status:
        otp.httpStatus,

      websocket_url_received:
        true,

      websocket_url_protocol:
        otp.url
          ? new URL(otp.url).protocol
          : null,

      websocket_host:
        otp.url
          ? new URL(otp.url).host
          : null
    });
  }

  /*
   * TEMPORARILY BLOCK TRADING REQUESTS.
   *
   * We are diagnosing the trading session first.
   */

  return json(
    {
      ok: false,

      error:
        "Trading is temporarily paused while the Deriv trading session is being diagnosed.",

      market:
        "1HZ100V"
    },
    400
  );
    }
