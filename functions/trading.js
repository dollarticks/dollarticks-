const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   RESPONSE
===================================================== */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

/* =====================================================
   COOKIE
===================================================== */

function getCookie(request, name) {
  const cookies =
    request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const i = part.indexOf("=");

    if (i === -1)
      continue;

    const key =
      part.slice(0, i).trim();

    if (key !== name)
      continue;

    try {
      return decodeURIComponent(
        part.slice(i + 1).trim()
      );
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
  const response =
    await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Deriv-App-ID":
            CLIENT_ID,

          Accept:
            "application/json"
        },

        cache:
          "no-store"
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

  if (Array.isArray(data?.data))
    return data.data;

  if (
    data?.data &&
    typeof data.data === "object"
  )
    return [data.data];

  if (Array.isArray(data))
    return data;

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
    account?.account_type ||
    "demo"
  ).toLowerCase();
}

function getAccountBalance(account) {
  const value =
    Number(
      account?.balance ?? 0
    );

  return Number.isFinite(value)
    ? value
    : 0;
}

function findAccount(
  accounts,
  requestedType
) {
  const wanted =
    String(
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
   OTP
===================================================== */

async function getOTP(
  token,
  accountId
) {
  const response =
    await fetch(
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

        cache:
          "no-store"
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

/* =====================================================
   WEBSOCKET
===================================================== */

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
          new WebSocket(wsUrl);

      } catch {
        clearTimeout(timeout);

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
          clearTimeout(timeout);
          resolve(ws);
        }
      );

      ws.addEventListener(
        "error",
        () => {

          clearTimeout(timeout);

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

function closeWebSocket(ws) {
  try {

    if (
      ws &&
      (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      )
    ) {
      ws.close();
    }

  } catch {}
}

/* =====================================================
   REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType,
  timeoutMs = 8000
) {
  return new Promise(
    (resolve, reject) => {

      let finished = false;

      const timeout =
        setTimeout(() => {

          if (finished)
            return;

          finished = true;

          cleanup();

          reject(
            new Error(
              `Trading service timed out waiting for ${wantedMsgType}.`
            )
          );

        }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);

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

        finished = true;

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

          finished = true;

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
          JSON.stringify(payload)
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
   CONTRACT TYPES
===================================================== */

const SUPPORTED_CONTRACTS =
  new Set([
    "HIGHER",
    "LOWER",

    "MULTUP",
    "MULTDOWN",

    "UPORDOWN",

    "EXPIRYRANGE",
    "EXPIRYRANGEE",

    "EXPIRYMISSE",
    "EXPIRYMISS",

    "ONETOUCH",
    "NOTOUCH",

    "CALL",
    "PUT",

    "CALLE",
    "PUTE",

    "RANGE",

    "ASIANU",
    "ASIAND",

    "DIGITDIFF",
    "DIGITMATCH",
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITODD",
    "DIGITEVEN",

    "TICKHIGH",
    "TICKLOW",

    "RESETCALL",
    "RESETPUT",

    "RUNHIGH",
    "RUNLOW",

    "ACCU",

    "VANILLALONGCALL",
    "VANILLALONGPUT",

    "TURBOSLONG",
    "TURBOSSHORT"
  ]);

const DIGIT_BARRIER_CONTRACTS =
  new Set([
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITDIFF"
  ]);

const MULTIPLIER_CONTRACTS =
  new Set([
    "MULTUP",
    "MULTDOWN"
  ]);

/* =====================================================
   PROPOSAL
===================================================== */

function buildProposalPayload({
  market,
  contractType,
  stake,
  duration,
  durationUnit,
  currency,
  barrier,
  multiplier,
  growthRate
}) {

  const payload = {

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
    DIGIT_BARRIER_CONTRACTS.has(
      contractType
    )
  ) {

    const digit =
      Number(barrier);

    if (
      !Number.isInteger(digit) ||
      digit < 0 ||
      digit > 9
    ) {
      throw new Error(
        "Digit barrier must be between 0 and 9."
      );
    }

    payload.barrier =
      String(digit);
  }

  if (
    MULTIPLIER_CONTRACTS.has(
      contractType
    )
  ) {

    const value =
      Number(multiplier);

    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      throw new Error(
        "Multiplier must be greater than 0."
      );
    }

    payload.multiplier =
      value;
  }

  if (
    contractType === "ACCU"
  ) {

    const value =
      Number(growthRate);

    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      throw new Error(
        "Growth rate is required."
      );
    }

    payload.growth_rate =
      value;
  }

  return payload;
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
    source?.is_expired === true ||
    source?.is_expired === 1;

  const profit =
    Number(
      source?.profit ?? 0
    );

  let status =
    rawStatus;

  /*
   * Deriv's current API uses is_sold
   * and proposal_open_contract updates.
   */

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
      Number.isFinite(profit)
        ? profit
        : 0,

    /*
     * Current Deriv field.
     */
    exit_spot:
      source?.exit_spot ??
      source?.sell_spot ??
      source?.exit_tick ??
      null,

    entry_spot:
      source?.entry_spot ??
      source?.entry_tick ??
      null,

    sell_price:
      Number(
        source?.sell_price ??
        source?.bid_price ??
        0
      ),

    contract_type:
      source?.contract_type ||
      null,

    underlying_symbol:
      source?.underlying_symbol ||
      source?.symbol ||
      null,

    barrier:
      source?.barrier ??
      null,

    currency:
      source?.currency ||
      null
  };
}

/* =====================================================
   FAST CONTRACT RESULT
===================================================== */

async function getContractResult(
  token,
  accountId,
  contractId
) {

  let ws;

  try {

    /*
     * Create authenticated trading session.
     */

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

        let finished = false;

        /*
         * We only use this as a safety
         * timeout. Normally the WebSocket
         * settles the request immediately.
         *
         * 6 seconds instead of 12 seconds.
         */

        const timeout =
          setTimeout(() => {

            finish({
              contract: {
                contract_id:
                  Number(contractId),

                status:
                  "OPEN",

                is_sold:
                  false,

                profit:
                  0
              }
            });

          }, 6000);

        function cleanup() {

          clearTimeout(timeout);

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

        function finish(result) {

          if (finished)
            return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          resolve(result);
        }

        function fail(error) {

          if (finished)
            return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          reject(
            error instanceof Error
              ? error
              : new Error(String(error))
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
              new Error(
                data.error.message ||
                data.error?.detail?.message ||
                "Deriv rejected the request."
              )
            );

            return;
          }

          if (
            data.msg_type !==
            "proposal_open_contract"
          ) {
            return;
          }

          const raw =
            data.proposal_open_contract;

          if (!raw)
            return;

          /*
           * Make sure this update belongs
           * to the requested contract.
           */

          const returnedContractId =
            Number(
              raw.contract_id
            );

          if (
            returnedContractId !==
            Number(contractId)
          ) {
            return;
          }

          const contract =
            normalizeContract(
              raw,
              contractId
            );

          /*
           * Deriv sends live updates through
           * proposal_open_contract.
           *
           * Once is_sold becomes true,
           * this is the final result.
           */

          const finishedContract =
            contract.is_sold ||
            contract.status === "WON" ||
            contract.status === "LOST";

          if (
            finishedContract
          ) {

            finish({
              contract
            });
          }
        }

        function onError() {

          fail(
            new Error(
              "Trading connection failed."
            )
          );
        }

        function onClose() {

          if (!finished) {

            fail(
              new Error(
                "Trading connection closed."
              )
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

        /*
         * Current Deriv request.
         *
         * No loginid is required.
         */

        try {

          ws.send(
            JSON.stringify({

              proposal_open_contract:
                1,

              contract_id:
                Number(contractId),

              subscribe:
                1,

              req_id:
                9001
            })
          );

        } catch(error) {

          fail(
            error
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

        connected:
          false,

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

  /* =====================================================
     ACCOUNT TYPE
  ===================================================== */

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

  /* =====================================================
     ACCOUNT
  ===================================================== */

  let selected;

  try {

    selected =
      await getSelectedAccount(
        token,
        requestedType
      );

  } catch(error) {

    return json(
      {
        ok: false,

        connected:
          false,

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

  /* =====================================================
     GET
  ===================================================== */

  if (
    request.method === "GET"
  ) {

    return json({

      ok:
        true,

      connected:
        true,

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

  /* =====================================================
     SELECT ACCOUNT
  ===================================================== */

  if (
    body.action ===
    "select_account"
  ) {

    return json({

      ok:
        true,

      connected:
        true,

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

  /* =====================================================
     BALANCE
  ===================================================== */

  if (
    body.action ===
    "balance"
  ) {

    try {

      const accounts =
        await getAccounts(
          token
        );

      const freshAccount =
        findAccount(
          accounts,
          accountType
        );

      if (freshAccount) {

        return json({

          ok:
            true,

          account: {

            account_id:
              getAccountId(
                freshAccount
              ),

            account_type:
              getAccountType(
                freshAccount
              )
          },

          balance:
            getAccountBalance(
              freshAccount
            ),

          currency:
            freshAccount.currency ||
            currency
        });
      }

    } catch(error) {

      console.error(
        "Fast balance error:",
        error
      );
    }

    return json({

      ok:
        true,

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

  /* =====================================================
     CONTRACT STATUS
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
          ok:
            false,

          error:
            "Invalid contract ID."
        },
        400
      );
    }

    try {

      const result =
        await getContractResult(
          token,
          accountId,
          contractId
        );

      return json({

        ok:
          true,

        contract:
          result.contract,

        account: {

          account_id:
            accountId,

          account_type:
            accountType
        }
      });

    } catch(error) {

      return json(
        {
          ok:
            false,

          connected:
            true,

          error:
            error.message ||
            "Could not check contract."
        },
        502
      );
    }
  }

  /* =====================================================
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
            balance:
              1,

            req_id:
              3001
          },

          "balance",

          8000
        );

      return json({

        ok:
          true,

        connected:
          true,

        trading_ready:
          true,

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

    } catch(error) {

      return json(
        {
          ok:
            false,

          connected:
            true,

          trading_ready:
            false,

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

  /* =====================================================
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

      const contractType =
        String(
          body.contract_type ||
          ""
        )
        .trim()
        .toUpperCase();

      if (!contractType) {

        throw new Error(
          "No contract type was selected."
        );
      }

      if (
        !SUPPORTED_CONTRACTS.has(
          contractType
        )
      ) {

        throw new Error(
          `Unsupported contract type: ${contractType}`
        );
      }

      const stake =
        Number(
          body.stake
        );

      if (
        !Number.isFinite(stake) ||
        stake <= 0
      ) {

        throw new Error(
          "Enter a valid stake greater than 0."
        );
      }

      const duration =
        Number(
          body.duration || 1
        );

      if (
        !Number.isFinite(duration) ||
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
        ).trim();

      const barrier =
        body.barrier ??
        "5";

      const multiplier =
        body.multiplier ??
        body.multiplier_value ??
        null;

      const growthRate =
        body.growth_rate ??
        body.growthRate ??
        null;

      /* -----------------------------------------------
         ONE AUTHENTICATED CONNECTION
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

      const proposalPayload =
        buildProposalPayload({

          market,

          contractType,

          stake,

          duration,

          durationUnit,

          currency,

          barrier,

          multiplier,

          growthRate

        });

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
        !Number.isFinite(askPrice) ||
        askPrice <= 0
      ) {

        throw new Error(
          "Deriv returned an invalid contract price."
        );
      }

      /* -----------------------------------------------
         PURCHASE IMMEDIATELY
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

      const balanceAfter =
        Number(
          buy.balance_after
        );

      return json({

        ok:
          true,

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

          underlying_symbol:
            market,

          contract_type:
            contractType,

          barrier:
            DIGIT_BARRIER_CONTRACTS.has(
              contractType
            )
              ? String(barrier)
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

    } catch(error) {

      console.error(
        "DollarTicks BUY ERROR:",
        error
      );

      return json(
        {
          ok:
            false,

          connected:
            true,

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

  /* =====================================================
     UNKNOWN
  ===================================================== */

  return json(
    {
      ok:
        false,

      error:
        `Unknown action: ${
          body.action || "none"
        }`
    },
    400
  );
}
