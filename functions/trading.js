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
   OTP / AUTHENTICATED WEBSOCKET
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

        }, 8000);

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
   NORMAL REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType,
  timeoutMs = 8000
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

/* =====================================================
   CLOSE WEBSOCKET
===================================================== */

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
   BALANCE FROM EXISTING WS
===================================================== */

async function getBalanceFromWS(ws) {

  try {

    const response =
      await sendRequest(
        ws,
        {
          balance: 1,
          req_id: 9001
        },
        "balance",
        5000
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

  } catch {

    return null;
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
    source?.is_sold === true ||
    source?.is_sold === 1 ||
    rawStatus === "WON" ||
    rawStatus === "LOST";

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
   FAST CONTRACT SETTLEMENT
   =====================================================

   IMPORTANT:

   The old version opened a NEW WebSocket every time
   the frontend checked the contract.

   This version opens ONE authenticated connection,
   subscribes to the contract, and waits for the
   settlement update.

   This removes the repeated:

   OTP -> WebSocket -> contract request -> close

   cycle.

===================================================== */

async function waitForContractSettlement(
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

    return await new Promise(
      (resolve, reject) => {

        let finished =
          false;

        const timeout =
          setTimeout(
            () => {

              if (finished)
                return;

              finished =
                true;

              cleanup();

              reject(
                new Error(
                  "Contract settlement check timed out."
                )
              );

            },
            12000
          );

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

        function finish(
          contract
        ) {

          if (finished)
            return;

          finished =
            true;

          cleanup();

          resolve(
            contract
          );
        }

        function fail(
          message
        ) {

          if (finished)
            return;

          finished =
            true;

          cleanup();

          reject(
            new Error(
              message
            )
          );
        }

        function onMessage(
          event
        ) {

          let data;

          try {

            data =
              JSON.parse(
                event.data
              );

          } catch {

            return;
          }

          if (
            data.error
          ) {

            fail(
              data.error.message ||
              data.error?.detail?.message ||
              "Deriv rejected the contract request."
            );

            return;
          }

          if (
            data.msg_type !==
            "proposal_open_contract"
          ) {

            return;
          }

          const source =
            data.proposal_open_contract;

          if (!source)
            return;

          const contract =
            normalizeContract(
              source,
              contractId
            );

          /*
           * If the contract is already finished,
           * return immediately.
           */

          if (
            contract.status === "WON" ||
            contract.status === "LOST" ||
            contract.is_sold === true
          ) {

            finish(
              contract
            );
          }
        }

        function onError() {

          fail(
            "Trading connection failed while checking the contract."
          );
        }

        function onClose() {

          if (!finished) {

            fail(
              "Trading connection closed while checking the contract."
            );
          }
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
            JSON.stringify({

              proposal_open_contract:
                1,

              contract_id:
                Number(
                  contractId
                ),

              subscribe:
                1,

              req_id:
                5001
            })
          );

        } catch {

          fail(
            "Could not subscribe to the contract."
          );
        }
      }
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
===================================================== */

  if (
    body.action ===
    "balance"
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

      const fresh =
        await getBalanceFromWS(
          ws
        );

      if (fresh) {

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
      }

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

    } finally {

      closeWebSocket(ws);
    }
  }

  /* ===================================================
     SESSION
===================================================== */

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
          "balance",
          6000
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
     FAST SUBSCRIPTION VERSION
===================================================== */

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

      /*
       * ONE connection.
       *
       * Subscribe to the contract and wait for
       * the settlement message instead of repeatedly
       * opening new connections.
       */

      const contract =
        await waitForContractSettlement(
          token,
          accountId,
          contractId
        );

      /*
       * Once settled, obtain the balance immediately.
       */

      let freshBalance =
        null;

      let balanceWs;

      try {

        const balanceWsUrl =
          await getOTP(
            token,
            accountId
          );

        balanceWs =
          await openWebSocket(
            balanceWsUrl
          );

        freshBalance =
          await getBalanceFromWS(
            balanceWs
          );

      } catch {

        freshBalance =
          null;

      } finally {

        closeWebSocket(
          balanceWs
        );
      }

      return json({

        ok: true,

        settled:
          contract.status === "WON" ||
          contract.status === "LOST" ||
          contract.is_sold === true,

        contract,

        balance:
          freshBalance?.balance ??
          null,

        currency:
          freshBalance?.currency ??
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
===================================================== */

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

      /* -----------------------------------------------
         ALL SUPPORTED DIGIT CONTRACTS
      ----------------------------------------------- */

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
        )
        .trim()
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

      /* -----------------------------------------------
         STAKE
         NO ARTIFICIAL LIMIT
      ----------------------------------------------- */

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
       * IMPORTANT:
       *
       * There is deliberately NO $1 maximum here.
       *
       * Deriv decides whether the selected stake is
       * valid for the selected market/account.
       */

      /* -----------------------------------------------
         DURATION
      ----------------------------------------------- */

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

      /* -----------------------------------------------
         BARRIER
      ----------------------------------------------- */

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

      /*
       * Over, Under, Matches and Differs can use
       * ANY digit from 0 through 9.
       */

      if (
        digitContracts.includes(
          contractType
        )
      ) {

        const digit =
          Number(
            barrier
          );

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

        proposal:
          1,

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

      /*
       * Only barrier-based digit contracts receive
       * a barrier.
       *
       * Even/Odd do NOT receive one.
       */

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
          "proposal",
          8000
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

          "buy",
          8000
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

      /* -----------------------------------------------
         IMMEDIATE BALANCE
      ----------------------------------------------- */

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
     UNKNOWN ACTION
===================================================== */

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
