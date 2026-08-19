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
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();

    if (key !== name) continue;

    const value = part.slice(index + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function findAccounts(value) {
  const accounts = [];

  function scan(item) {
    if (!item) return;

    if (Array.isArray(item)) {
      for (const child of item) {
        scan(child);
      }
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

    for (const child of Object.values(item)) {
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

function findDemoAccount(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) {
    return null;
  }

  const explicitDemo = accounts.find(account => {
    return String(
      account.account_type || ""
    ).toLowerCase() === "demo";
  });

  if (explicitDemo) return explicitDemo;

  const dotAccount = accounts.find(account => {
    const id = String(
      account.account_id ||
      account.id ||
      ""
    ).toUpperCase();

    return id.startsWith("DOT");
  });

  if (dotAccount) return dotAccount;

  const vrtDemo = accounts.find(account => {
    const loginid = String(
      account.loginid || ""
    ).toUpperCase();

    return (
      loginid.startsWith("VRT") ||
      loginid.startsWith("VRTC")
    );
  });

  if (vrtDemo) return vrtDemo;

  return accounts[0] || null;
}

async function getAuthenticatedAccounts(accessToken) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts`,
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Deriv-App-ID": CLIENT_ID,
        "Accept": "application/json"
      },
      cache: "no-store"
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Deriv rejected the account request.";

    throw new Error(message);
  }

  return findAccounts(data);
}

async function getOtpUrl(accessToken, accountId) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Deriv-App-ID": CLIENT_ID,
        "Accept": "application/json"
      },
      cache: "no-store"
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Deriv could not create a trading WebSocket session.";

    throw new Error(message);
  }

  const wsUrl = data?.data?.url;

  if (!wsUrl) {
    throw new Error(
      "Deriv did not return an authenticated WebSocket URL."
    );
  }

  return wsUrl;
}

function websocketRequest(wsUrl, payload, expectedType) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;

      settled = true;

      try {
        ws.close();
      } catch {}

      callback(value);
    };

    let ws;

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error("Timed out waiting for Deriv.")
      );
    }, 15000);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        finish(reject, error);
      }
    };

    ws.onmessage = event => {
      try {
        const data = JSON.parse(event.data);

        if (data.error) {
          clearTimeout(timeout);

          const message =
            data.error.message ||
            "Deriv returned an error.";

          finish(
            reject,
            new Error(message)
          );

          return;
        }

        if (data.msg_type === expectedType) {
          clearTimeout(timeout);
          finish(resolve, data);
        }
      } catch (error) {
        clearTimeout(timeout);
        finish(reject, error);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);

      finish(
        reject,
        new Error(
          "Deriv trading WebSocket connection failed."
        )
      );
    };

    ws.onclose = () => {
      if (!settled) {
        clearTimeout(timeout);

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

  const accessToken =
    getCookie(request, "dt_access_token");

  if (!accessToken) {
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
      await getAuthenticatedAccounts(
        accessToken
      );
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
        "No Deriv Options account was returned."
    });
  }

  const selectedAccount =
    findDemoAccount(accounts);

  if (!selectedAccount) {
    return json({
      ok: false,
      connected: false,
      error:
        "No usable Deriv Options account found."
    });
  }

  const accountId =
    selectedAccount.account_id ||
    selectedAccount.id ||
    selectedAccount.loginid;

  const accountType =
    String(
      selectedAccount.account_type ||
      "demo"
    ).toLowerCase();

  if (request.method === "GET") {
    return json({
      ok: true,
      connected: true,
      selected_account: {
        account_id: accountId,
        loginid:
          selectedAccount.loginid ||
          null,
        account_type: accountType,
        currency:
          selectedAccount.currency ||
          "USD",
        status:
          selectedAccount.status ||
          "active"
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
        error: "Invalid JSON request."
      },
      400
    );
  }

  if (
    body.account_type &&
    String(body.account_type).toLowerCase() !==
      "demo"
  ) {
    return json(
      {
        ok: false,
        error:
          "Only DEMO trading is enabled."
      },
      403
    );
  }

  if (accountType !== "demo") {
    return json(
      {
        ok: false,
        error:
          "A DEMO Deriv account must be connected."
      },
      403
    );
  }

  let wsUrl;

  try {
    wsUrl =
      await getOtpUrl(
        accessToken,
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

  if (body.action === "proposal") {
    const market =
      body.market ||
      body.underlying_symbol;

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

    const contractType =
      String(
        body.contract_type || ""
      ).toUpperCase();

    const allowedContracts = [
      "DIGITOVER",
      "DIGITUNDER",
      "DIGITMATCH",
      "DIGITDIFF",
      "DIGITEVEN",
      "DIGITODD"
    ];

    if (
      !allowedContracts.includes(
        contractType
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "Unsupported digit contract type."
        },
        400
      );
    }

    const stake =
      Number(body.stake);

    const duration =
      Number(body.duration);

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

    const proposalRequest = {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency:
        selectedAccount.currency ||
        "USD",
      duration:
        Math.floor(duration),
      duration_unit:
        body.duration_unit || "t",
      underlying_symbol: market,
      req_id: 1
    };

    if (
      [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ].includes(contractType)
    ) {
      proposalRequest.barrier =
        String(body.barrier ?? 5);
    }

    try {
      const result =
        await websocketRequest(
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
      return json(
        {
          ok: false,
          error: error.message
        },
        502
      );
    }
  }

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
        await websocketRequest(
          wsUrl,
          {
            buy: proposalId,
            price: price,
            req_id: 2
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
      "DollarTicks trading error:",
      error
    );

    return json(
      {
        ok: false,
        error:
          error?.message ||
          "Internal trading function error."
      },
      500
    );
  }
    }
