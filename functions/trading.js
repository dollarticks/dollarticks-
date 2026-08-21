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
   ACCOUNT HELPERS
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
   OTP
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

        }, 10000);

      try {
        ws =
          new WebSocket(
            wsUrl
          );
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
   SEND REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType,
  timeoutMs = 10000
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
        "balance",
        8000
      );

    const value =
      Number(
        response?.balance?.balance
      );

    return {
      balance:
        Number.isFinite(value)
          ? value
          : 0,

      currency:
        response?.balance?.currency ||
        "USD"
    };

  } finally {

    closeWebSocket(ws);
  }
}

/* =====================================================
   ALL SUPPORTED CONTRACT TYPES
===================================================== */

/*
 * These are the current contract_type values exposed
 * by Deriv's proposal API.
 *
 * The important digit contracts are:
 *
 * DIGITOVER
 * DIGITUNDER
 * DIGITMATCH
 * DIGITDIFF
 * DIGITEVEN
 * DIGITODD
 *
 * Other supported types are also accepted here.
 */

const SUPPORTED_CONTRACTS = new Set([

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

const CALL_PUT_CONTRACTS =
  new Set([
    "CALL",
    "PUT"
  ]);

const EVEN_ODD_CONTRACTS =
  new Set([
    "DIGITEVEN",
    "DIGITODD"
  ]);

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
    source?.is_sold === 1;

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
      null,

    sell_price:
      Number(
        source?.sell_price ??
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
      null
  };
}

/* =====================================================
   CONTRACT RESULT
===================================================== */

/*
 * One authenticated WebSocket connection is used.
 *
 * Flow:
 *
 * OTP
 * ↓
 * authenticated WebSocket
 * ↓
 * subscribe to contract
 * ↓
 * wait for WON / LOST
 * ↓
 * request balance on SAME socket
 * ↓
 * return result
 */

async function getContractResultFast(
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

        let finished = false;

        let contractTimeout = null;

        let balanceTimeout = null;

        function cleanup() {

          if(contractTimeout)
            clearTimeout(
              contractTimeout
            );

          if(balanceTimeout)
            clearTimeout(
              balanceTimeout
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

        function finish(result) {

          if(finished)
            return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          resolve(result);
        }

        function fail(error) {

          if(finished)
            return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          reject(
            error instanceof Error
              ? error
              : new Error(
                  String(error)
                )
          );
        }

        function requestBalance(contract) {

          /*
           * IMPORTANT:
           *
           * Balance handling is already inside the
           * main message listener.
           *
           * We send a unique req_id and wait for the
           * balance response there.
           */

          try {

            ws.send(
              JSON.stringify({

                balance: 1,

                req_id:
                  9002

              })
            );

          } catch {

            finish({
              contract
            });

            return;
          }

          balanceTimeout =
            setTimeout(() => {

              finish({
                contract
              });

            }, 3000);
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

          if(data.error){

            fail(
              new Error(
                data.error.message ||
                data.error?.detail?.message ||
                "Deriv rejected the request."
              )
            );

            return;
          }

          /* -------------------------------------------
             CONTRACT UPDATE
          ------------------------------------------- */

          if(
            data.msg_type ===
            "proposal_open_contract"
          ){

            const raw =
              data.proposal_open_contract;

            if(!raw)
              return;

            const contract =
              normalizeContract(
                raw,
                contractId
              );

            const sold =
              contract.is_sold === true ||
              contract.status === "WON" ||
              contract.status === "LOST";

            if(!sold)
              return;

            /*
             * Contract has finished.
             *
             * Ask for the final balance.
             */

            requestBalance(
              contract
            );

            return;
          }

          /* -------------------------------------------
             BALANCE RESPONSE
          ------------------------------------------- */

          if(
            data.msg_type ===
            "balance" &&
            Number(
              data?.req_id
            ) === 9002
          ){

            if(balanceTimeout)
              clearTimeout(
                balanceTimeout
              );

            const value =
              Number(
                data?.balance?.balance
              );

            finish({
              contract:
                currentCompletedContract,

              balance:
                Number.isFinite(value)
                  ? value
                  : null,

              currency:
                data?.balance?.currency ||
                "USD"
            });

            return;
          }
        }

        let currentCompletedContract = null;

        /*
         * Keep a small wrapper so the contract object is
         * available when balance arrives.
         */

        const originalRequestBalance =
          requestBalance;

        requestBalance =
          function(contract) {

            currentCompletedContract =
              contract;

            originalRequestBalance(
              contract
            );
          };

        function onError() {

          fail(
            new Error(
              "Trading connection failed."
            )
          );
        }

        function onClose() {

          if(!finished){

            fail(
              new Error(
                "Trading connection closed before the contract result was received."
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
         * Subscribe to the contract.
         */

        try {

          ws.send(
            JSON.stringify({

              proposal_open_contract: 1,

              contract_id:
                Number(contractId),

              subscribe: 1,

              req_id:
                9001

            })
          );

        } catch {

          fail(
            new Error(
              "Could not subscribe to contract updates."
            )
          );

          return;
        }

        /*
         * Safety timeout.
         *
         * We do NOT report a false WIN/LOSS.
         * We simply return OPEN so the frontend can
         * retry the status request.
         */

        contractTimeout =
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

          }, 15000);
      }
    );

  } catch(error) {

    closeWebSocket(ws);

    throw error;
  }
}

/* =====================================================
   BUILD PROPOSAL
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

    subscribe:
      1,

    req_id:
      4001

  };

  /*
   * DIGIT OVER / UNDER / MATCH / DIFF
   */

  if(
    DIGIT_BARRIER_CONTRACTS.has(
      contractType
    )
  ){

    const digit =
      Number(barrier);

    if(
      !Number.isInteger(digit) ||
      digit < 0 ||
      digit > 9
    ){

      throw new Error(
        "Digit barrier must be between 0 and 9."
      );
    }

    payload.barrier =
      String(digit);
  }

  /*
   * MULTIPLIERS
   */

  if(
    MULTIPLIER_CONTRACTS.has(
      contractType
    )
  ){

    const value =
      Number(
        multiplier
      );

    if(
      !Number.isFinite(value) ||
      value <= 0
    ){

      throw new Error(
        "Multiplier must be greater than 0."
      );
    }

    payload.multiplier =
      value;
  }

  /*
   * ACCUMULATORS
   */

  if(
    contractType === "ACCU"
  ){

    const value =
      Number(
        growthRate
      );

    if(
      !Number.isFinite(value) ||
      value <= 0
    ){

      throw new Error(
        "Growth rate is required for Accumulator contracts."
      );
    }

    payload.growth_rate =
      value;
  }

  return payload;
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

  /* ===================================================
     ACCOUNT TYPE
  =================================================== */

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

  /* ===================================================
     SELECT ACCOUNT
  =================================================== */

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
          "balance",
          8000
        );

      return json({

        ok: true,

        connected: true,

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

    } catch (error) {

      return json(
        {
          ok: false,
          connected: true,
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

      const result =
        await getContractResultFast(
          token,
          accountId,
          contractId
        );

      const contract =
        result?.contract ||
        null;

      if(!contract){

        return json(
          {
            ok: false,
            connected: true,
            error:
              "No contract data was returned."
          },
          502
        );
      }

      return json({

        ok: true,

        contract,

        balance:
          Number.isFinite(
            Number(
              result?.balance
            )
          )
            ? Number(
                result.balance
              )
            : null,

        currency:
          result?.currency ||
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

      /*
       * We no longer reject valid Deriv contract
       * types with a digit-only whitelist.
       */

      const contractType =
        String(
          body.contract_type ||
          ""
        )
        .trim()
        .toUpperCase();

      if(!contractType){

        throw new Error(
          "No contract type was selected."
        );
      }

      if(
        !SUPPORTED_CONTRACTS.has(
          contractType
        )
      ){

        throw new Error(
          `Unsupported contract type: ${contractType}`
        );
      }

      /* -----------------------------------------------
         STAKE
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
        )
        .trim();

      if(!durationUnit){

        throw new Error(
          "Duration unit is required."
        );
      }

      /* -----------------------------------------------
         BARRIER
      ----------------------------------------------- */

      const barrier =
        body.barrier ??
        "5";

      /* -----------------------------------------------
         MULTIPLIER
      ----------------------------------------------- */

      const multiplier =
        body.multiplier ??
        body.multiplier_value ??
        null;

      /* -----------------------------------------------
         ACCUMULATOR GROWTH
      ----------------------------------------------- */

      const growthRate =
        body.growth_rate ??
        body.growthRate ??
        null;

      /* -----------------------------------------------
         AUTHENTICATED WS
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
          10000
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

          10000
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
