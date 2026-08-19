const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";

  for (const part of header.split(";")) {
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
  const result = [];

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
      result.push(item);
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

  return result.filter(account => {
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

function findDemoAccount(accounts) {
  if (!accounts.length) return null;

  const demo = accounts.find(account =>
    String(
      account.account_type || ""
    ).toLowerCase() === "demo"
  );

  if (demo) return demo;

  const dot = accounts.find(account =>
    String(
      account.account_id ||
      account.id ||
      ""
    ).toUpperCase().startsWith("DOT")
  );

  if (dot) return dot;

  const vrt = accounts.find(account =>
    String(
      account.loginid || ""
    ).toUpperCase().startsWith("VRT")
  );

  if (vrt) return vrt;

  return accounts[0];
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
      "Unable to retrieve Deriv accounts."
    );
  }

  return findAccounts(data);
}

async function getTradingWebSocketUrl(
  token,
  accountId
) {
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
      "Unable to create Deriv trading session."
    );
  }

  if (!data?.data?.url) {
    throw new Error(
      "Deriv did not return a trading WebSocket URL."
    );
  }

  return data.data.url;
}

function sendWebSocketRequest(
  wsUrl,
  payload,
  expectedType
) {
  return new Promise((resolve, reject) => {
    let finished = false;

    let ws;

    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Deriv trading request timed out."
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
      try {
        ws.send(
          JSON.stringify(payload)
        );
      } catch (error) {
        finish(reject, error);
      }
    };

    ws.onmessage = event => {
      try {
        const data =
          JSON.parse(event.data);

        console.log(
          "Deriv WS response:",
          data
        );

        if (data.error) {
          finish(
            reject,
            new Error(
              data.error.message ||
              "Deriv returned an error."
            )
          );
          return;
        }

        if (
          data.msg_type === expectedType
        ) {
          finish(resolve, data);
        }
      } catch (error) {
        finish(reject, error);
      }
    };

    ws.onerror = () => {
      finish(
        reject,
        new Error(
          "Deriv trading WebSocket connection failed."
        )
      );
    };

    ws.onclose = () => {
      if (!finished) {
        finish(
          reject,
          new Error(
            "Deriv trading WebSocket closed unexpectedly."
          )
        );
      }
    };
  });
}

async function handleRequest(context) {
  const request = context.request;

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
        error: error.message
      },
      401
    );
  }

  if (!accounts.length) {
    return json({
      ok: false,
      connected: false,
      error:
        "No Deriv Options account found."
    });
  }

  const selected =
    findDemoAccount(accounts);

  if (!selected) {
    return json({
      ok: false,
      connected: false,
      error:
        "No usable Deriv account found."
    });
  }

  const accountId =
    selected.account_id ||
    selected.id ||
    selected.loginid;

  const accountType =
    String(
      selected.account_type ||
      "demo"
    ).toLowerCase();

  if (request.method === "GET") {
    return json({
      ok: true,
      connected: true,
      selected_account: {
        account_id: accountId,
        loginid:
          selected.loginid || null,
        account_type: accountType,
        currency:
          selected.currency || "USD",
        status:
          selected.status || "active"
      }
    });
  }

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method not allowed."
      },
      405
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid JSON."
      },
      400
    );
  }

  if (accountType !== "demo") {
    return json(
      {
        ok: false,
        error:
          "Please connect a DEMO account."
      },
      403
    );
  }

  let wsUrl;

  try {
    wsUrl =
      await getTradingWebSocketUrl(
        token,
        accountId
      );
  } catch (error) {
    return json(
      {
        ok: false,
        error: error.message
      },
      502
    );
  }

  /*
   * =================================================
   * PROPOSAL
   * =================================================
   */

  if (body.action === "proposal") {
    const market =
      body.market ||
      body.underlying_symbol;

    const contractType =
      String(
        body.contract_type || ""
      ).toUpperCase();

    const stake =
      Number(body.stake);

    const duration =
      Number(body.duration);

    if (!market) {
      return json(
        {
          ok: false,
          error:
            "No market was selected."
        },
        400
      );
    }

    const validContracts = [
      "DIGITOVER",
      "DIGITUNDER",
      "DIGITMATCH",
      "DIGITDIFF",
      "DIGITEVEN",
      "DIGITODD"
    ];

    if (
      !validContracts.includes(
        contractType
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "Invalid digit contract type."
        },
        400
      );
    }

    if (
      !Number.isFinite(stake) ||
      stake <= 0
    ) {
      return json(
        {
          ok: false,
          error: "Invalid stake."
        },
        400
      );
    }

    if (
      !Number.isFinite(duration) ||
      duration < 1
    ) {
      return json(
        {
          ok: false,
          error:
            "Invalid duration."
        },
        400
      );
    }

    /*
     * This follows Deriv's current
     * proposal request structure.
     */

    const proposalRequest = {
      proposal: 1,

      amount: stake,

      basis: "stake",

      contract_type:
        contractType,

      currency:
        selected.currency || "USD",

      duration:
        Math.floor(duration),

      duration_unit:
        body.duration_unit || "t",

      underlying_symbol:
        market,

      subscribe: 1,

      req_id: 1
    };

    /*
     * Digit contracts require a barrier.
     */

    if (
      contractType === "DIGITOVER" ||
      contractType === "DIGITUNDER" ||
      contractType === "DIGITMATCH" ||
      contractType === "DIGITDIFF"
    ) {
      proposalRequest.barrier =
        String(
          body.barrier ?? "5"
        );
    }

    console.log(
      "DollarTicks proposal request:",
      proposalRequest
    );

    try {
      const result =
        await sendWebSocketRequest(
          wsUrl,
          proposalRequest,
          "proposal"
        );

      return json({
        ok: true,
        proposal:
          result.proposal
      });

    } catch (error) {
      console.error(
        "Proposal error:",
        error
      );

      return json(
        {
          ok: false,
          error: error.message
        },
        502
      );
    }
  }

  /*
   * =================================================
   * BUY
   * =================================================
   */

  if (body.action === "buy") {
    const proposalId =
      String(
        body.proposal_id || ""
      );

    const price =
      Number(body.price);

    if (!proposalId) {
      return json(
        {
          ok: false,
          error:
            "Missing proposal ID."
        },
        400
      );
    }

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return json(
        {
          ok: false,
          error:
            "Invalid purchase price."
        },
        400
      );
    }

    try {
      const result =
        await sendWebSocketRequest(
          wsUrl,
          {
            buy:
              proposalId,

            price:
              price,

            req_id:
              2
          },
          "buy"
        );

      return json({
        ok: true,
        contract:
          result.buy
      });

    } catch (error) {
      return json(
        {
          ok: false,
          error: error.message
        },
        502
      );
    }
  }

  return json(
    {
      ok: false,
      error:
        "Unknown trading action."
    },
    400
  );
}

export async function onRequest(context) {
  try {
    return await handleRequest(context);
  } catch (error) {
    console.error(
      "DollarTicks error:",
      error
    );

    return json(
      {
        ok: false,
        error:
          error?.message ||
          "Internal server error."
      },
      500
    );
  }
      }
