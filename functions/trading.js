const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   JSON
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

    if (i === -1) continue;

    const key =
      part.slice(0, i).trim();

    if (key !== name) continue;

    const value =
      part.slice(i + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

/* =====================================================
   GET OPTIONS ACCOUNTS
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
      data?.error?.message ||
      "Trading service could not retrieve the account."
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

/* =====================================================
   ACCOUNT HELPERS
===================================================== */

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


function formatAccount(account) {

  return {
    account_id:
      getAccountId(account),

    account_type:
      getAccountType(account),

    balance:
      getAccountBalance(account),

    currency:
      account?.currency ||
      "USD",

    status:
      account?.status ||
      "active"
  };
}


/* =====================================================
   FIND ACCOUNT
===================================================== */

function findAccount(
  accounts,
  requestedType
) {

  const wanted =
    String(
      requestedType ||
      "demo"
    ).toLowerCase();

  return (
    accounts.find(
      account =>
        getAccountType(account) ===
        wanted
    ) ||
    null
  );
}


/* =====================================================
   GET SELECTED ACCOUNT
===================================================== */

async function getSelectedAccount(
  token,
  requestedType
) {

  const type =
    requestedType === "real"
      ? "real"
      : "demo";

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
      type
    );

  if (!account) {
    throw new Error(
      `No ${type.toUpperCase()} trading account is available.`
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
      account?.currency ||
      "USD"
  };
}


/* =====================================================
   CREATE AUTHENTICATED WEBSOCKET URL
===================================================== */

async function getOTP(
  token,
  accountId
) {

  const response =
    await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
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
      `Trading session service returned HTTP ${response.status}.`
    );
  }

  console.log(
    "DollarTicks OTP RESPONSE:",
    data
  );

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
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
      "Trading service did not return an authenticated WebSocket URL."
    );
  }

  if (
    !String(wsUrl)
      .startsWith("wss://")
  ) {
    throw new Error(
      "Trading service returned an invalid WebSocket URL."
    );
  }

  return wsUrl;
}


/* =====================================================
   OPEN WEBSOCKET
===================================================== */

function openWebSocket(
  wsUrl
) {

  return new Promise(
    (resolve, reject) => {

      let ws;

      const timeout =
        setTimeout(
          () => {

            try {
              ws?.close();
            } catch {}

            reject(
              new Error(
                "Trading connection timed out."
              )
            );

          },
          20000
        );


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
            "Could not open the trading connection."
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

          console.log(
            "DollarTicks authenticated WebSocket connected."
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
   SEND REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType
) {

  return new Promise(
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
                "Trading service timed out."
              )
            );

          },
          20000
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


      function finishError(
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


        console.log(
          "DollarTicks WebSocket response:",
          data
        );


        if (data.error) {

          finishError(
            data.error.message ||
            "Deriv rejected the trading request."
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

        finishError(
          "Trading connection failed."
        );

      }


      function onClose() {

        finishError(
          "Trading connection closed unexpectedly."
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

        console.log(
          "DollarTicks request sent:",
          payload
        );

      } catch {

        finishError(
          "Could not send the trading request."
        );

      }

    }
  );
}


/* =====================================================
   CLOSE WEBSOCKET
===================================================== */

function closeWebSocket(
  ws
) {

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
   VALIDATE CONTRACT TYPE
===================================================== */

const VALID_CONTRACTS = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITMATCH",
  "DIGITDIFF",
  "DIGITEVEN",
  "DIGITODD"
];


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


  /* ===================================================
     ACCESS TOKEN
  =================================================== */

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
          "Trading session is unavailable. Please log in again."
      },
      401
    );

  }


  /* ===================================================
     REQUEST BODY
  =================================================== */

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
     GET ACCOUNT
  =================================================== */

  let selected;


  try {

    selected =
      await getSelectedAccount(
        token,
        requestedType
      );

  } catch (error) {

    console.error(
      "DollarTicks ACCOUNT ERROR:",
      error
    );

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


  /* ===================================================
     GET
===================================================== */

  if (
    request.method === "GET"
  ) {

    return json(
      {
        ok: true,

        connected: true,

        account:
          formatAccount(
            account
          )
      }
    );

  }


  /* ===================================================
     SELECT ACCOUNT
     
     This was missing from your old trading.js.
===================================================== */

  if (
    body.action ===
    "select_account"
  ) {

    return json(
      {
        ok: true,

        connected: true,

        message:
          `${accountType.toUpperCase()} account selected.`,

        account:
          formatAccount(
            account
          )
      }
    );

  }


  /* ===================================================
     BALANCE
===================================================== */

  if (
    body.action ===
    "balance"
  ) {

    return json(
      {
        ok: true,

        connected: true,

        balance,

        currency,

        account: {
          account_id:
            accountId,

          account_type:
            accountType
        }
      }
    );

  }


  /* ===================================================
     TRADING SESSION TEST
===================================================== */

  if (
    body.action === "session" ||
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


      const test =
        await sendRequest(
          ws,

          {
            balance: 1,
            req_id: 10
          },

          "balance"
        );


      return json(
        {
          ok: true,

          connected: true,

          trading_ready:
            true,

          balance:
            test?.balance?.balance ??
            balance,

          currency:
            test?.balance?.currency ??
            currency,

          account: {
            account_id:
              accountId,

            account_type:
              accountType
          }
        }
      );

    } catch (error) {

      console.error(
        "DollarTicks SESSION ERROR:",
        error
      );

      return json(
        {
          ok: false,

          connected: true,

          trading_ready:
            false,

          error:
            error.message ||
            "Trading session could not be established."
        },
        502
      );

    } finally {

      closeWebSocket(
        ws
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

      /* -----------------------------------------------
         MARKET
      ----------------------------------------------- */

      const market =
        String(
          body.market ||
          body.symbol ||
          body.underlying_symbol ||
          ""
        ).trim();


      if (!market) {

        throw new Error(
          "No trading market was selected."
        );

      }


      /* -----------------------------------------------
         CONTRACT TYPE
      ----------------------------------------------- */

      const contractType =
        String(
          body.contract_type ||
          ""
        ).trim()
        .toUpperCase();


      if (
        !VALID_CONTRACTS.includes(
          contractType
        )
      ) {

        throw new Error(
          "Invalid digit contract type."
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
        !Number.isFinite(stake) ||
        stake <= 0
      ) {

        throw new Error(
          "Enter a valid stake."
        );

      }


      /* -----------------------------------------------
         DURATION
      ----------------------------------------------- */

      const duration =
        Number(
          body.duration ||
          1
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
        );


      const allowedUnits = [
        "t",
        "s",
        "m",
        "h",
        "d"
      ];


      if (
        !allowedUnits.includes(
          durationUnit
        )
      ) {

        throw new Error(
          "Invalid duration unit."
        );

      }


      /* -----------------------------------------------
         BARRIER
      ----------------------------------------------- */

      const barrier =
        String(
          body.barrier ??
          "5"
        );


      if (
        !/^[0-9]$/.test(
          barrier
        )
      ) {

        throw new Error(
          "Digit barrier must be between 0 and 9."
        );

      }


      /* -----------------------------------------------
         GET AUTHENTICATED WEBSOCKET
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
          1

      };


      const barrierContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ];


      if (
        barrierContracts.includes(
          contractType
        )
      ) {

        proposalPayload.barrier =
          barrier;

      }


      const parityContracts = [
        "DIGITEVEN",
        "DIGITODD"
      ];


      /*
       * Even/Odd does not use the
       * digit barrier.
       */


      if (
        parityContracts.includes(
          contractType
        )
      ) {

        delete proposalPayload.barrier;

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


      /* -----------------------------------------------
         ASK PRICE
      ----------------------------------------------- */

      const askPrice =
        Number(
          proposal.ask_price
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
              2
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


      const contractId =
        buy.contract_id;


      /* -----------------------------------------------
         RETURN PURCHASE
      ----------------------------------------------- */

      return json(
        {
          ok: true,

          message:
            "Contract purchased successfully.",

          contract: {

            contract_id:
              contractId,

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

            is_sold:
              Boolean(
                buy.is_sold
              ),

            account_type:
              accountType,

            account_id:
              accountId,

            market:
              market,

            contract_type:
              contractType,

            barrier:
              barrierContracts.includes(
                contractType
              )
                ? barrier
                : null
          }
        }
      );

    } catch (error) {

      console.error(
        "DollarTicks BUY ERROR:",
        error
      );

      return json(
        {
          ok: false,

          connected:
            true,

          error:
            error.message ||
            "Purchase failed."
        },
        400
      );

    } finally {

      closeWebSocket(
        ws
      );

    }

  }


  /* ===================================================
     CONTRACT STATUS
     
     NEW:
     This allows index.html to ask the
     backend whether the contract is
     still open, won, or lost.
===================================================== */

  if (
    body.action ===
      "contract_status" ||
    body.action ===
      "check_contract"
  ) {

    let ws;

    try {

      const contractId =
        String(
          body.contract_id ||
          ""
        ).trim();


      if (!contractId) {

        throw new Error(
          "No contract ID was provided."
        );

      }


      /* -----------------------------------------------
         NEW AUTHENTICATED CONNECTION
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
         REQUEST CONTRACT STATUS
      ----------------------------------------------- */

      const response =
        await sendRequest(
          ws,

          {
            proposal_open_contract:
              1,

            contract_id:
              contractId,

            req_id:
              20

          },

          "proposal_open_contract"
        );


      const contract =
        response?.proposal_open_contract;


      if (!contract) {

        throw new Error(
          "Deriv did not return contract information."
        );

      }


      const profit =
        Number(
          contract.profit ?? 0
        );


      const isSold =
        Boolean(
          contract.is_sold
        );


      const rawStatus =
        String(
          contract.status ||
          ""
        ).toLowerCase();


      let finalStatus =
        "OPEN";


      if (
        isSold ||
        rawStatus === "won" ||
        rawStatus === "lost"
      ) {

        if (
          rawStatus === "won" ||
          profit > 0
        ) {

          finalStatus =
            "WON";

        } else if (
          rawStatus === "lost" ||
          profit < 0
        ) {

          finalStatus =
            "LOST";

        } else {

          finalStatus =
            "CLOSED";

        }

      }


      return json(
        {
          ok: true,

          contract: {

            contract_id:
              contract.contract_id ||
              contractId,

            contract_type:
              contract.contract_type ||
              null,

            status:
              finalStatus,

            deriv_status:
              contract.status ||
              null,

            is_sold:
              isSold,

            profit:
              profit,

            buy_price:
              Number(
                contract.buy_price ??
                0
              ),

            payout:
              Number(
                contract.payout ??
                0
              ),

            current_spot:
              contract.current_spot ??
              null,

            exit_spot:
              contract.exit_spot ??
              null,

            exit_spot_time:
              contract.exit_spot_time ??
              null,

            currency:
              contract.currency ||
              currency,

            account_type:
              accountType,

            account_id:
              accountId
          }
        }
      );

    } catch (error) {

      console.error(
        "DollarTicks CONTRACT STATUS ERROR:",
        error
      );

      return json(
        {
          ok: false,

          connected:
            true,

          error:
            error.message ||
            "Could not check contract status."
        },
        400
      );

    } finally {

      closeWebSocket(
        ws
      );

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
          body.action ||
          "none"
        }`
    },
    400
  );

       }
