const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   JSON RESPONSE
===================================================== */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

/* =====================================================
   COOKIE
===================================================== */

function getCookie(request, name) {

  const header =
    request.headers.get("Cookie") || "";

  for (const part of header.split(";")) {

    const index =
      part.indexOf("=");

    if (index === -1)
      continue;

    const key =
      part.slice(0, index).trim();

    if (key !== name)
      continue;

    const value =
      part.slice(index + 1).trim();

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
          "Authorization":
            `Bearer ${token}`,

          "Deriv-App-ID":
            CLIENT_ID,

          "Accept":
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
      "Deriv returned an invalid account response."
    );

  }

  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not retrieve Deriv Options accounts."
    );

  }

  /*
   * Deriv may return:
   *
   * data: [...]
   *
   * or:
   *
   * data: {...}
   */

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

function accountId(account) {

  return (
    account?.account_id ||
    account?.loginid ||
    account?.id ||
    null
  );

}


function accountType(account) {

  return String(
    account?.account_type || ""
  ).toLowerCase();

}


function accountBalance(account) {

  const value =
    Number(
      account?.balance
    );

  return Number.isFinite(value)
    ? value
    : 0;

}


function findAccount(
  accounts,
  wantedType
) {

  const wanted =
    String(
      wantedType || "demo"
    ).toLowerCase();

  return (
    accounts.find(
      account =>
        accountType(account) === wanted
    ) || null
  );

}

/* =====================================================
   SELECT ACCOUNT
===================================================== */

async function selectAccount(
  token,
  wantedType
) {

  const accounts =
    await getAccounts(token);

  if (!accounts.length) {

    throw new Error(
      "No Deriv Options trading account was found."
    );

  }

  const account =
    findAccount(
      accounts,
      wantedType
    );

  if (!account) {

    throw new Error(
      `No ${String(wantedType).toUpperCase()} Options account is available.`
    );

  }

  const id =
    accountId(account);

  if (!id) {

    throw new Error(
      "Deriv returned an account without an account ID."
    );

  }

  return {

    account,

    accountId:
      id,

    accountType:
      accountType(account) || wantedType,

    balance:
      accountBalance(account),

    currency:
      account.currency || "USD"

  };

}

/* =====================================================
   GET AUTHENTICATED WEBSOCKET URL
===================================================== */

async function getTradingWebSocket(
  token,
  accountIdValue
) {

  const response =
    await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountIdValue)}/otp`,
      {
        method: "POST",

        headers: {
          "Authorization":
            `Bearer ${token}`,

          "Deriv-App-ID":
            CLIENT_ID,

          "Accept":
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
      `Deriv OTP service returned HTTP ${response.status}.`
    );

  }

  console.log(
    "DollarTicks OTP:",
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

  /*
   * Current Deriv API returns:
   *
   * data.url
   *
   * The URL already contains the OTP.
   */

  const wsUrl =
    data?.data?.url ||
    data?.url;

  if (!wsUrl) {

    throw new Error(
      "Deriv did not return an authenticated WebSocket URL."
    );

  }

  if (
    !String(wsUrl).startsWith("wss://")
  ) {

    throw new Error(
      "Deriv returned an invalid WebSocket URL."
    );

  }

  return wsUrl;

}

/* =====================================================
   OPEN AUTHENTICATED WEBSOCKET
===================================================== */

function openWebSocket(
  wsUrl
) {

  return new Promise(
    (resolve, reject) => {

      let settled = false;

      let ws;

      const timeout =
        setTimeout(
          () => {

            if (settled)
              return;

            settled = true;

            try {
              ws?.close();
            } catch {}

            reject(
              new Error(
                "Trading WebSocket connection timed out."
              )
            );

          },
          20000
        );


      try {

        /*
         * IMPORTANT:
         *
         * Do NOT add Authorization headers here.
         *
         * The OTP is already inside
         * the WebSocket URL.
         */

        ws =
          new WebSocket(
            wsUrl
          );

      } catch {

        clearTimeout(timeout);

        reject(
          new Error(
            "Could not open the Deriv trading WebSocket."
          )
        );

        return;

      }


      ws.addEventListener(
        "open",
        () => {

          if (settled)
            return;

          settled = true;

          clearTimeout(timeout);

          console.log(
            "DollarTicks authenticated WebSocket connected."
          );

          resolve(ws);

        }
      );


      ws.addEventListener(
        "error",
        () => {

          if (settled)
            return;

          settled = true;

          clearTimeout(timeout);

          try {
            ws?.close();
          } catch {}

          reject(
            new Error(
              "Deriv trading WebSocket connection failed."
            )
          );

        }
      );

    }
  );

}

/* =====================================================
   SEND WEBSOCKET REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  expectedType
) {

  return new Promise(
    (resolve, reject) => {

      let finished = false;


      const timeout =
        setTimeout(
          () => {

            if (finished)
              return;

            finished = true;

            cleanup();

            reject(
              new Error(
                `Deriv did not respond to the ${expectedType} request.`
              )
            );

          },
          20000
        );


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
          new Error(
            message
          )
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


        console.log(
          "DollarTicks WS response:",
          data
        );


        if (data.error) {

          fail(
            data.error.message ||
            "Deriv rejected the trading request."
          );

          return;

        }


        if (
          data.msg_type ===
          expectedType
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
          "Deriv trading WebSocket failed."
        );

      }


      function onClose() {

        fail(
          "Deriv trading WebSocket closed unexpectedly."
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
          "DollarTicks WS request:",
          payload
        );

      } catch {

        fail(
          "Could not send the trading request."
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
   MAIN FUNCTION
===================================================== */

export async function onRequest(
  context
) {

  const request =
    context.request;


  /* -----------------------------------------------------
     METHOD
  ----------------------------------------------------- */

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


  /* -----------------------------------------------------
     TOKEN
  ----------------------------------------------------- */

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
          "No DollarTicks trading session. Please log in again."
      },
      401
    );

  }


  /* -----------------------------------------------------
     REQUEST BODY
  ----------------------------------------------------- */

  let body = {};


  if (
    request.method ===
    "POST"
  ) {

    try {

      body =
        await request.json();

    } catch {

      return json(
        {
          ok: false,
          error:
            "Invalid JSON trading request."
        },
        400
      );

    }

  }


  /* -----------------------------------------------------
     ACCOUNT TYPE
  ----------------------------------------------------- */

  let wantedType =
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

      wantedType =
        queryType;

    }

  } catch {}


  if (
    body.account_type === "demo" ||
    body.account_type === "real"
  ) {

    wantedType =
      body.account_type;

  }


  /* -----------------------------------------------------
     LOAD ACCOUNT
  ----------------------------------------------------- */

  let selected;


  try {

    selected =
      await selectAccount(
        token,
        wantedType
      );

  } catch (error) {

    console.error(
      "DollarTicks ACCOUNT ERROR:",
      error
    );

    return json(
      {
        ok: false,
        connected: false,
        error:
          error.message ||
          "Could not access the Deriv Options account."
      },
      400
    );

  }


  const {
    account,
    accountId:
      selectedAccountId,
    accountType:
      selectedAccountType,
    balance,
    currency
  } =
    selected;


  /* =====================================================
     GET
  ===================================================== */

  if (
    request.method ===
    "GET"
  ) {

    return json({

      ok: true,

      connected: true,

      account: {

        account_id:
          selectedAccountId,

        account_type:
          selectedAccountType,

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

    let ws;

    try {

      const wsUrl =
        await getTradingWebSocket(
          token,
          selectedAccountId
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
            req_id: 100
          },
          "balance"
        );

      return json({

        ok: true,

        connected: true,

        balance:
          Number(
            result?.balance?.balance ??
            balance
          ),

        currency:
          result?.balance?.currency ||
          currency,

        account: {

          account_id:
            selectedAccountId,

          account_type:
            selectedAccountType

        }

      });

    } catch (error) {

      console.error(
        "DollarTicks BALANCE ERROR:",
        error
      );

      return json(
        {
          ok: false,
          connected: true,
          error:
            error.message ||
            "Could not retrieve the live balance."
        },
        502
      );

    } finally {

      closeWebSocket(ws);

    }

  }


  /* =====================================================
     TRADING SESSION TEST
  ===================================================== */

  if (
    body.action === "session" ||
    body.action === "trading_session"
  ) {

    let ws;

    try {

      const wsUrl =
        await getTradingWebSocket(
          token,
          selectedAccountId
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
            req_id: 101
          },
          "balance"
        );

      return json({

        ok: true,

        connected: true,

        trading_ready: true,

        balance:
          Number(
            result?.balance?.balance ??
            balance
          ),

        currency:
          result?.balance?.currency ||
          currency,

        account: {

          account_id:
            selectedAccountId,

          account_type:
            selectedAccountType

        }

      });

    } catch (error) {

      console.error(
        "DollarTicks SESSION ERROR:",
        error
      );

      return json(
        {
          ok: false,
          connected: true,
          trading_ready: false,
          error:
            error.message ||
            "Trading session could not be established."
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
        ).trim();


      if (!contractType) {

        throw new Error(
          "No contract type was selected."
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
          body.duration
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


      const allowedUnits =
        [
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
         DIGIT VALIDATION
      ----------------------------------------------- */

      const digitTypes =
        [
          "DIGITOVER",
          "DIGITUNDER",
          "DIGITMATCH",
          "DIGITDIFF"
        ];


      let barrier = null;


      if (
        digitTypes.includes(
          contractType
        )
      ) {

        const barrierNumber =
          Number(
            body.barrier
          );


        if (
          !Number.isInteger(
            barrierNumber
          ) ||
          barrierNumber < 0 ||
          barrierNumber > 9
        ) {

          throw new Error(
            "Digit barrier must be a number from 0 to 9."
          );

        }


        barrier =
          String(
            barrierNumber
          );

      }


      /* -----------------------------------------------
         GET FRESH OTP
      ----------------------------------------------- */

      const wsUrl =
        await getTradingWebSocket(
          token,
          selectedAccountId
        );


      /*
       * OTP is short-lived and one-time-use.
       *
       * Connect immediately.
       */

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
          200

      };


      if (
        barrier !== null
      ) {

        proposalPayload.barrier =
          barrier;

      }


      console.log(
        "DollarTicks PROPOSAL:",
        proposalPayload
      );


      const proposalResponse =
        await sendRequest(
          ws,
          proposalPayload,
          "proposal"
        );


      const proposal =
        proposalResponse?.proposal;


      if (!proposal) {

        throw new Error(
          "Deriv returned no proposal."
        );

      }


      if (!proposal.id) {

        throw new Error(
          "Deriv returned a proposal without an ID."
        );

      }


      /* -----------------------------------------------
         PRICE
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
          "Deriv returned an invalid proposal price."
        );

      }


      /* -----------------------------------------------
         BUY
      ----------------------------------------------- */

      const buyPayload = {

        buy:
          String(
            proposal.id
          ),

        price:
          askPrice,

        req_id:
          201

      };


      console.log(
        "DollarTicks BUY:",
        buyPayload
      );


      const buyResponse =
        await sendRequest(
          ws,
          buyPayload,
          "buy"
        );


      const buy =
        buyResponse?.buy;


      if (
        !buy ||
        !buy.contract_id
      ) {

        throw new Error(
          "Deriv accepted the request but did not return a contract ID."
        );

      }


      /* -----------------------------------------------
         SUCCESS
      ----------------------------------------------- */

      return json({

        ok: true,

        message:
          "Contract purchased successfully.",

        contract: {

          contract_id:
            buy.contract_id,

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
            selectedAccountType,

          account_id:
            selectedAccountId,

          market:
            market,

          contract_type:
            contractType,

          barrier:
            barrier

        },

        proposal: {

          id:
            proposal.id,

          ask_price:
            askPrice,

          payout:
            Number(
              proposal.payout ??
              0
            )

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


  /* =====================================================
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
