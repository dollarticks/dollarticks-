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

function websocketRequest(
  wsUrl,
  request,
  expectedType
) {
  return new Promise((resolve, reject) => {

    let ws;
    let finished = false;

    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Deriv request timed out."
        )
      );
    }, 15000);

    function finish(callback, value) {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      try {
        ws?.close();
      } catch {}

      callback(value);
    }

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      finish(reject, error);
      return;
    }

    ws.onopen = () => {

      console.log(
        "DollarTicks diagnostic request:",
        request
      );

      ws.send(
        JSON.stringify(request)
      );

    };

    ws.onmessage = event => {

      try {

        const data =
          JSON.parse(event.data);

        console.log(
          "DollarTicks Deriv response:",
          data
        );

        if (data.error) {

          finish(
            reject,
            new Error(
              data.error.message ||
              JSON.stringify(data.error)
            )
          );

          return;
        }

        if (
          data.msg_type ===
          expectedType
        ) {

          finish(
            resolve,
            data
          );

        }

      } catch (error) {

        finish(
          reject,
          error
        );

      }

    };

    ws.onerror = () => {

      finish(
        reject,
        new Error(
          "Trading WebSocket connection failed."
        )
      );

    };

    ws.onclose = () => {

      if (!finished) {

        finish(
          reject,
          new Error(
            "Trading WebSocket closed unexpectedly."
          )
        );

      }

    };

  });
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
   * ==========================================
   * NORMAL ACCOUNT CHECK
   * ==========================================
   */

  const diagnostic =
    url.searchParams.get(
      "diagnostic"
    );

  if (
    request.method === "GET" &&
    diagnostic !== "1"
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
   * ==========================================
   * CONTRACT DIAGNOSTIC
   * ==========================================
   */

  if (
    diagnostic === "1"
  ) {

    try {

      const wsUrl =
        await getOTP(
          token,
          accountId
        );

      const result =
        await websocketRequest(

          wsUrl,

          {
            contracts_for:
              "1HZ100V",

            req_id:
              1001
          },

          "contracts_for"

        );

      const contractsFor =
        result?.contracts_for ||
        {};

      const available =
        contractsFor.available ||
        [];

      return json({

        ok: true,

        diagnostic:
          "contracts_for",

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

        contract_count:
          available.length,

        contracts:
          available.map(contract => ({

            contract_type:
              contract.contract_type ||
              null,

            contract_category:
              contract.contract_category ||
              null,

            market:
              contract.market ||
              null,

            submarket:
              contract.submarket ||
              null,

            underlying_symbol:
              contract.underlying_symbol ||
              null,

            expiry_type:
              contract.expiry_type ||
              null

          })),

        raw:
          contractsFor

      });

    } catch (error) {

      console.error(
        "DollarTicks diagnostic failed:",
        error
      );

      return json(

        {
          ok: false,

          diagnostic:
            "contracts_for",

          market:
            "1HZ100V",

          error:
            error.message
        },

        502

      );

    }

  }

  /*
   * ==========================================
   * BLOCK NORMAL POST FOR NOW
   * ==========================================
   *
   * We intentionally do NOT send proposals yet.
   * First we need the exact contracts returned
   * by Deriv.
   */

  return json({

    ok: false,

    error:
      "Diagnostic mode required. Open /trading?diagnostic=1 first.",

    market:
      "1HZ100V"

  }, 400);

            }
