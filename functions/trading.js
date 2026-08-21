const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   RESPONSE
===================================================== */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

/* =====================================================
   COOKIE
===================================================== */

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const i = part.indexOf("=");

    if (i === -1) continue;

    const key = part.slice(0, i).trim();

    if (key !== name) continue;

    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }

  return null;
}

/* =====================================================
   ACCOUNTS
===================================================== */

async function getAccounts(token) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": CLIENT_ID,
        Accept: "application/json"
      },
      cache: "no-store"
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Trading service returned an invalid account response."
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.errors?.[0]?.detail?.message ||
      data?.error?.message ||
      "Could not retrieve trading accounts."
    );
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (
    data?.data &&
    typeof data.data === "object"
  ) {
    return [data.data];
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function getAccountId(account) {
  return (
    account?.account_id ||
    account?.loginid ||
    account?.id ||
    null
  );
}

function getAccountType(account) {
  return String(
    account?.account_type || "demo"
  ).toLowerCase();
}

function getAccountBalance(account) {
  const value = Number(
    account?.balance ?? 0
  );

  return Number.isFinite(value)
    ? value
    : 0;
}

function findAccount(accounts, requestedType) {
  const wanted = String(
    requestedType || "demo"
  ).toLowerCase();

  return (
    accounts.find(
      account =>
        getAccountType(account) === wanted
    ) || null
  );
}

async function getSelectedAccount(
  token,
  requestedType
) {
  const accounts =
    await getAccounts(token);

  if (!accounts.length) {
    throw new Error(
      "No trading account is available."
    );
  }

  const account =
    findAccount(
      accounts,
      requestedType
    );

  if (!account) {
    throw new Error(
      `No ${String(
        requestedType
      ).toUpperCase()} trading account is available.`
    );
  }

  const accountId =
    getAccountId(account);

  if (!accountId) {
    throw new Error(
      "Trading account information is incomplete."
    );
  }

  return {
    account,
    accountId,
    accountType:
      getAccountType(account),
    balance:
      getAccountBalance(account),
    currency:
      account.currency || "USD"
  };
}

/* =====================================================
   OTP / AUTHENTICATED WS
===================================================== */

async function getOTP(
  token,
  accountId
) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(
      accountId
    )}/otp`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${token}`,
        "Deriv-App-ID":
          CLIENT_ID,
        Accept:
          "application/json"
      },
      cache: "no-store"
    }
  );

  const raw =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    throw new Error(
      `Trading session returned HTTP ${response.status}.`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.errors?.[0]?.detail?.message ||
      data?.error?.message ||
      data?.message ||
      `Could not create trading session. HTTP ${response.status}`
    );
  }

  const wsUrl =
    data?.data?.url ||
    data?.url;

  if (!wsUrl) {
    throw new Error(
      "Trading service did not return a WebSocket URL."
    );
  }

  if (
    !String(wsUrl)
      .startsWith("wss://")
  ) {
    throw new Error(
      "Invalid trading WebSocket URL."
    );
  }

  return wsUrl;
}

function openWebSocket(wsUrl) {
  return new Promise(
    (resolve, reject) => {

      let ws;

      const timeout =
        setTimeout(() => {

          try {
            ws?.close();
          } catch {}

          reject(
            new Error(
              "Trading connection timed out."
            )
          );

        }, 12000);

      try {
        ws =
          new WebSocket(
            wsUrl
          );
      } catch {

        clearTimeout(
          timeout
        );

        reject(
          new Error(
            "Could not open trading connection."
          )
        );

        return;
      }

      ws.addEventListener(
        "open",
        () => {

          clearTimeout(
            timeout
          );

          resolve(ws);
        }
      );

      ws.addEventListener(
        "error",
        () => {

          clearTimeout(
            timeout
          );

          try {
            ws?.close();
          } catch {}

          reject(
            new Error(
              "Trading connection failed."
            )
          );
        }
      );
    }
  );
}

/* =====================================================
   REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType,
  timeoutMs = 12000
) {
  return new Promise(
    (resolve, reject) => {

      let finished =
        false;

      const timeout =
        setTimeout(() => {

          if (finished)
            return;

          finished =
            true;

          cleanup();

          reject(
            new Error(
              "Trading service timed out."
            )
          );

        }, timeoutMs);

      function cleanup() {

        clearTimeout(
          timeout
        );

        ws.removeEventListener(
          "message",
          onMessage
        );

        ws.removeEventListener(
          "error",
          onError
        );

        ws.removeEventListener(
          "close",
          onClose
        );
      }

      function fail(message) {

        if (finished)
          return;

        finished =
          true;

        cleanup();

        reject(
          new Error(message)
        );
      }

      function onMessage(event) {

        let data;

        try {
          data =
            JSON.parse(
              event.data
            );
        } catch {
          return;
        }

        if (data.error) {

          fail(
            data.error.message ||
            data.error?.detail?.message ||
            "Deriv rejected the request."
          );

          return;
        }

        if (
          data.msg_type ===
          wantedMsgType
        ) {

          if (finished)
            return;

          finished =
            true;

          cleanup();

          resolve(data);
        }
      }

      function onError() {

        fail(
          "Trading connection failed."
        );
      }

      function onClose() {

        fail(
          "Trading connection closed."
        );
      }

      ws.addEventListener(
        "message",
        onMessage
      );

      ws.addEventListener(
        "error",
        onError
      );

      ws.addEventListener(
        "close",
        onClose
      );

      try {

        ws.send(
          JSON.stringify(
            payload
          )
        );

      } catch {

        fail(
          "Could not send trading request."
        );
      }
    }
  );
}

function closeWebSocket(ws) {
  try {

    if (
      ws &&
      (
        ws.readyState ===
          WebSocket.OPEN ||
        ws.readyState ===
          WebSocket.CONNECTING
      )
    ) {
      ws.close();
    }

  } catch {}
}

/* =====================================================
   BALANCE
===================================================== */

async function getFreshBalance(
  token,
  accountId
) {

  let ws;

  try {

    const wsUrl =
      await getOTP(
        token,
        accountId
      );

    ws =
      await openWebSocket(
        wsUrl
      );

    const response =
      await sendRequest(
        ws,
        {
          balance: 1,
          req_id: 1001
        },
        "balance"
      );

    return {
      balance:
        Number(
          response?.balance?.balance ??
          0
        ),

      currency:
        response?.balance?.currency ||
        "USD"
    };

  } finally {

    closeWebSocket(ws);
  }
}

/* =====================================================
   CONTRACT NORMALIZER
===================================================== */

function normalizeContract(
  source,
  fallbackContractId
) {

  const rawStatus =
    String(
      source?.status ||
      source?.contract_status ||
      ""
    ).toUpperCase();

  const isSold =
    source?.is_sold === true;

  const profit =
    Number(
      source?.profit ?? 0
    );

  let status =
    rawStatus;

  if (
    isSold &&
    status !== "WON" &&
    status !== "LOST"
  ) {

    status =
      profit > 0
        ? "WON"
        : "LOST";
  }

  if (!status) {

    status =
      isSold
        ? (
            profit > 0
              ? "WON"
              : "LOST"
          )
        : "OPEN";
  }

  return {

    contract_id:
      Number(
        source?.contract_id ??
        fallbackContractId
      ),

    status,

    is_sold:
      isSold,

    buy_price:
      Number(
        source?.buy_price ??
        source?.buy_price_amount ??
        0
      ),

    payout:
      Number(
        source?.payout ?? 0
      ),

    profit:
      Number.isFinite(
        profit
      )
        ? profit
        : 0,

    exit_spot:
      source?.exit_tick ??
      source?.exit_spot ??
      null,

    entry_spot:
      source?.entry_tick ??
      source?.entry_spot ??
      null
  };
}

/* =====================================================
   CONTRACT STATUS - ONE CHECK
===================================================== */

async function getContractStatus(
  token,
  accountId,
  contractId
) {

  let ws;

  try {

    const wsUrl =
      await getOTP(
        token,
        accountId
      );

    ws =
      await openWebSocket(
        wsUrl
      );

    const response =
      await sendRequest(
        ws,
        {
          proposal_open_contract: 1,
          contract_id:
            Number(contractId),
          req_id:
            2001
        },
        "proposal_open_contract"
      );

    const contract =
      response?.proposal_open_contract;

    if (!contract) {

      throw new Error(
        "No contract information returned."
      );
    }

    return normalizeContract(
      contract,
      contractId
    );

  } finally {

    closeWebSocket(ws);
  }
}

/* =====================================================
   MAIN
===================================================== */

export async function onRequest(
  context
) {

  const request =
    context.request;

  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {

    return json(
      {
        ok: false,
        error:
          "Method not allowed."
      },
      405
    );
  }

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
          "Trading session unavailable. Please log in again."
      },
      401
    );
  }

  let body = {};

  if (
    request.method === "POST"
  ) {

    try {

      body =
        await request.json();

    } catch {

      return json(
        {
          ok: false,
          error:
            "Invalid trading request."
        },
        400
      );
    }
  }

  let requestedType =
    "demo";

  try {

    const url =
      new URL(
        request.url
      );

    const queryType =
      url.searchParams.get(
        "account_type"
      );

    if (
      queryType === "demo" ||
      queryType === "real"
    ) {

      requestedType =
        queryType;
    }

  } catch {}

  if (
    body.account_type === "demo" ||
    body.account_type === "real"
  ) {

    requestedType =
      body.account_type;
  }

  let selected;

  try {

    selected =
      await getSelectedAccount(
        token,
        requestedType
      );

  } catch (error) {

    return json(
      {
        ok: false,
        connected: false,
        error:
          error.message ||
          "Trading account unavailable."
      },
      400
    );
  }

  const {
    account,
    accountId,
    accountType,
    balance,
    currency
  } = selected;

  /* ===================================================
     GET ACCOUNT
  =================================================== */

  if (
    request.method === "GET"
  ) {

    return json({

      ok: true,

      connected: true,

      account: {

        account_id:
          accountId,

        account_type:
          accountType,

        balance:
          balance,

        currency:
          currency,

        status:
          account.status ||
          "active"
      }
    });
  }

  /* ===================================================
     SELECT ACCOUNT
  =================================================== */

  if (
    body.action ===
    "select_account"
  ) {

    return json({

      ok: true,

      connected: true,

      account: {

        account_id:
          accountId,

        account_type:
          accountType,

        balance:
          balance,

        currency:
          currency,

        status:
          account.status ||
          "active"
      }
    });
  }

  /* ===================================================
     BALANCE
  =================================================== */

  if (
    body.action ===
    "balance"
  ) {

    try {

      const fresh =
        await getFreshBalance(
          token,
          accountId
        );

      return json({

        ok: true,

        account: {

          account_id:
            accountId,

          account_type:
            accountType
        },

        balance:
          fresh.balance,

        currency:
          fresh.currency
      });

    } catch {

      return json({

        ok: true,

        account: {

          account_id:
            accountId,

          account_type:
            accountType
        },

        balance:
          balance,

        currency:
          currency
      });
    }
  }

  /* ===================================================
     SESSION
  =================================================== */

  if (
    body.action ===
      "session" ||
    body.action ===
      "trading_session"
  ) {

    let ws;

    try {

      const wsUrl =
        await getOTP(
          token,
          accountId
        );

      ws =
        await openWebSocket(
          wsUrl
        );

      const result =
        await sendRequest(
          ws,
          {
            balance: 1,
            req_id: 3001
          },
          "balance"
        );

      return json({

        ok: true,

        connected: true,

        trading_ready: true,

        balance:
          result?.balance?.balance ??
          balance,

        currency:
          result?.balance?.currency ??
          currency,

        account: {

          account_id:
            accountId,

          account_type:
            accountType
        }
      });

    } catch (error) {

      return json(
        {
          ok: false,
          connected: true,
          trading_ready: false,
          error:
            error.message ||
            "Trading session failed."
        },
        502
      );

    } finally {

      closeWebSocket(ws);
    }
  }

  /* ===================================================
     CONTRACT STATUS
  =================================================== */

  if (
    body.action ===
    "contract_status"
  ) {

    const contractId =
      Number(
        body.contract_id
      );

    if (
      !Number.isFinite(
        contractId
      ) ||
      contractId <= 0
    ) {

      return json(
        {
          ok: false,
          error:
            "Invalid contract ID."
        },
        400
      );
    }

    try {

      const contract =
        await getContractStatus(
          token,
          accountId,
          contractId
        );

      return json({

        ok: true,

        contract,

        account: {

          account_id:
            accountId,

          account_type:
            accountType
        }
      });

    } catch (error) {

      return json(
        {
          ok: false,
          connected: true,
          error:
            error.message ||
            "Could not check contract."
        },
        502
      );
    }
  }

  /* ===================================================
     BUY
  =================================================== */

  if (
    body.action ===
    "buy"
  ) {

    let ws;

    try {

      const market =
        String(
          body.market ||
          body.underlying_symbol ||
          body.symbol ||
          ""
        ).trim();

      if (!market) {

        throw new Error(
          "No trading market was selected."
        );
      }

      const allowedContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF",
        "DIGITEVEN",
        "DIGITODD"
      ];

      const contractType =
        String(
          body.contract_type ||
          ""
        ).trim()
        .toUpperCase();

      if (
        !allowedContracts.includes(
          contractType
        )
      ) {

        throw new Error(
          "Invalid digit contract type."
        );
      }

      const stake =
        Number(
          body.stake
        );

      if (
        !Number.isFinite(
          stake
        ) ||
        stake <= 0
      ) {

        throw new Error(
          "Enter a valid stake greater than 0."
        );
      }

      /*
       * No artificial $1 maximum.
       * Deriv itself decides whether the amount
       * is valid for the selected account/contract.
       */

      const duration =
        Number(
          body.duration || 1
        );

      if (
        !Number.isFinite(
          duration
        ) ||
        duration < 1
      ) {

        throw new Error(
          "Enter a valid duration."
        );
      }

      const durationUnit =
        String(
          body.duration_unit ||
          "t"
        );

      const barrier =
        String(
          body.barrier ??
          "5"
        );

      const digitContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ];

      if (
        digitContracts.includes(
          contractType
        )
      ) {

        const digit =
          Number(barrier);

        if (
          !Number.isInteger(
            digit
          ) ||
          digit < 0 ||
          digit > 9
        ) {

          throw new Error(
            "Digit must be between 0 and 9."
          );
        }
      }

      /* -----------------------------------------------
         AUTHENTICATED CONNECTION
      ----------------------------------------------- */

      const wsUrl =
        await getOTP(
          token,
          accountId
        );

      ws =
        await openWebSocket(
          wsUrl
        );

      /* -----------------------------------------------
         PROPOSAL
      ----------------------------------------------- */

      const proposalPayload = {

        proposal: 1,

        amount:
          stake,

        basis:
          "stake",

        contract_type:
          contractType,

        currency:
          currency,

        duration:
          duration,

        duration_unit:
          durationUnit,

        underlying_symbol:
          market,

        req_id:
          4001
      };

      if (
        digitContracts.includes(
          contractType
        )
      ) {

        proposalPayload.barrier =
          barrier;
      }

      const proposalResponse =
        await sendRequest(
          ws,
          proposalPayload,
          "proposal"
        );

      const proposal =
        proposalResponse?.proposal;

      if (!proposal?.id) {

        throw new Error(
          "Deriv did not return a valid proposal."
        );
      }

      const askPrice =
        Number(
          proposal.ask_price ??
          proposal.display_value ??
          stake
        );

      if (
        !Number.isFinite(
          askPrice
        ) ||
        askPrice <= 0
      ) {

        throw new Error(
          "Deriv returned an invalid contract price."
        );
      }

      /* -----------------------------------------------
         BUY
      ----------------------------------------------- */

      const buyResponse =
        await sendRequest(
          ws,
          {

            buy:
              String(
                proposal.id
              ),

            price:
              askPrice,

            req_id:
              4002
          },

          "buy"
        );

      const buy =
        buyResponse?.buy;

      if (
        !buy?.contract_id
      ) {

        throw new Error(
          "Deriv did not return a contract ID."
        );
      }

      /*
       * Use the balance_after returned by BUY
       * immediately instead of waiting for another
       * REST balance request.
       */

      const balanceAfter =
        Number(
          buy.balance_after
        );

      /* -----------------------------------------------
         RETURN BUY RESULT
      ----------------------------------------------- */

      return json({

        ok: true,

        message:
          "Contract purchased successfully.",

        contract: {

          contract_id:
            Number(
              buy.contract_id
            ),

          buy_price:
            Number(
              buy.buy_price ??
              askPrice
            ),

          payout:
            Number(
              buy.payout ??
              proposal.payout ??
              0
            ),

          profit:
            Number(
              buy.profit ??
              0
            ),

          status:
            String(
              buy.status ||
              "OPEN"
            ).toUpperCase(),

          account_type:
            accountType,

          account_id:
            accountId,

          market:
            market,

          contract_type:
            contractType,

          barrier:
            digitContracts.includes(
              contractType
            )
              ? barrier
              : null
        },

        account: {

          account_id:
            accountId,

          account_type:
            accountType,

          balance:
            Number.isFinite(
              balanceAfter
            )
              ? balanceAfter
              : balance,

          currency:
            currency
        }
      });

    } catch (error) {

      console.error(
        "DollarTicks BUY ERROR:",
        error
      );

      return json(
        {
          ok: false,
          connected: true,
          error:
            error.message ||
            "Purchase failed."
        },
        400
      );

    } finally {

      closeWebSocket(ws);
    }
  }

  /* ===================================================
     UNKNOWN
  =================================================== */

  return json(
    {
      ok: false,
      error:
        `Unknown action: ${
          body.action || "none"
        }`
    },
    400
  );
     }
