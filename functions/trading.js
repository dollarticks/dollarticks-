const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();

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

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not create trading session."
    );
  }

  if (!data?.data?.url) {
    throw new Error(
      "Deriv did not return a WebSocket URL."
    );
  }

  return data.data.url;
}

/*
 * Test the authenticated Options WebSocket.
 *
 * IMPORTANT:
 * The OTP URL returned by Deriv is used directly.
 * No extra authentication headers are added.
 */

function testWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {

    let ws = null;
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        ws?.close();
      } catch {}

      reject(
        new Error(
          "WebSocket timed out before Deriv returned a response."
        )
      );

    }, 15000);

    function done(callback, value) {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      try {
        ws?.close();
      } catch {}

      callback(value);
    }

    try {
      /*
       * Connect directly to the URL returned
       * by Deriv's OTP endpoint.
       */
      ws = new WebSocket(wsUrl);

    } catch (error) {

      done(
        reject,
        new Error(
          `WebSocket constructor failed: ${
            error?.message || String(error)
          }`
        )
      );

      return;
    }

    ws.onopen = () => {

      /*
       * contracts_for is a public market-data
       * request and does not need subscribe.
       */

      ws.send(
        JSON.stringify({
          contracts_for: "1HZ100V",
          req_id: 9001
        })
      );

    };

    ws.onmessage = event => {

      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        done(
          reject,
          new Error(
            "Deriv sent a non-JSON WebSocket response."
          )
        );

        return;
      }

      /*
       * Authentication or API error.
       */
      if (data.error) {

        done(
          reject,
          new Error(
            data.error.message ||
            JSON.stringify(data.error)
          )
        );

        return;
      }

      /*
       * Successful contracts_for response.
       */
      if (
        data.msg_type === "contracts_for"
      ) {

        const available =
          data.contracts_for?.available || [];

        done(
          resolve,
          {
            connected: true,
            message:
              "Authenticated trading WebSocket connected successfully.",
            contract_count:
              available.length,
            contracts:
              available.map(contract => ({
                contract_type:
                  contract.contract_type,

                contract_category:
                  contract.contract_category,

                market:
                  contract.market,

                submarket:
                  contract.submarket,

                underlying_symbol:
                  contract.underlying_symbol,

                expiry_type:
                  contract.expiry_type
              }))
          }
        );

        return;
      }

      /*
       * If Deriv sends an unexpected response,
       * keep listening until timeout.
       */
    };

    ws.onerror = () => {

      done(
        reject,
        new Error(
          "Deriv WebSocket reported a connection error."
        )
      );

    };

    ws.onclose = event => {

      if (finished) return;

      done(
        reject,
        new Error(
          `Deriv WebSocket closed before completing the request. Code: ${
            event?.code ?? "unknown"
          }`
        )
      );

    };

  });
}

export async function onRequest(context) {

  const request = context.request;
  const url = new URL(request.url);

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
   * WEBSOCKET DIAGNOSTIC
   */

  if (
    url.searchParams.get("diagnostic") === "1"
  ) {

    try {

      /*
       * Get a fresh OTP.
       *
       * Deriv says the OTP is short-lived,
       * so we immediately use its URL.
       */

      const wsUrl =
        await getOTP(
          token,
          accountId
        );

      /*
       * Do NOT expose wsUrl.
       */

      const result =
        await testWebSocket(wsUrl);

      return json({
        ok: true,

        diagnostic:
          "websocket",

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

        websocket:
          result
      });

    } catch (error) {

      return json(
        {
          ok: false,

          diagnostic:
            "websocket",

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
            error?.message ||
            String(error)
        },
        502
      );

    }

  }

  /*
   * Trading remains disabled during
   * this diagnostic step.
   */

  return json(
    {
      ok: false,

      error:
        "Trading is temporarily paused while the authenticated WebSocket is being tested."
    },
    400
  );

  }
