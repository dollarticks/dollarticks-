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

    const i =
      part.indexOf("=");

    if (i === -1) continue;

    const key =
      part.slice(0, i).trim();

    if (key !== name) continue;

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
   OPTIONS ACCOUNTS
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

  const data =
    await response.json();

  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not retrieve Deriv Options accounts."
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


/* =====================================================
   SELECT ACCOUNT
===================================================== */

async function getSelectedAccount(
  token,
  requestedType
) {

  const accounts =
    await getAccounts(token);

  if (!accounts.length) {

    throw new Error(
      "No Deriv Options account found."
    );

  }

  const wanted =
    String(
      requestedType || "demo"
    ).toLowerCase();

  const account =
    accounts.find(
      item =>
        getAccountType(item) === wanted
    );

  if (!account) {

    throw new Error(
      `No ${wanted.toUpperCase()} Options account found.`
    );

  }

  const accountId =
    getAccountId(account);

  if (!accountId) {

    throw new Error(
      "Deriv returned an account without an account ID."
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
   GET DERIV OTP
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

  const data =
    await response.json();

  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not create Deriv trading session."
    );

  }

  const wsUrl =
    data?.data?.url;

  if (!wsUrl) {

    throw new Error(
      "Deriv did not return an authenticated WebSocket URL."
    );

  }

  return wsUrl;
}


/* =====================================================
   CLOUDFLARE OUTBOUND WEBSOCKET
===================================================== */

async function connectDerivWebSocket(wsUrl) {

  /*
   * Cloudflare Workers supports establishing an
   * outbound WebSocket using fetch() + Upgrade.
   */

  const response =
    await fetch(
      wsUrl,
      {
        headers: {
          Upgrade:
            "websocket"
        }
      }
    );

  if (!response.webSocket) {

    throw new Error(
      `Deriv WebSocket handshake failed. HTTP status: ${response.status}`
    );

  }

  const ws =
    response.webSocket;

  ws.accept();

  return ws;
}


/* =====================================================
   SEND ONE REQUEST AND WAIT FOR RESPONSE
===================================================== */

function sendAndWait(
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

            finish(
              reject,
              new Error(
                `Timed out waiting for ${expectedType}.`
              )
            );

          },
          20000
        );


      function finish(
        callback,
        value
      ) {

        if (finished) return;

        finished = true;

        clearTimeout(timeout);

        callback(value);

      }


      function onMessage(event) {

        try {

          const data =
            JSON.parse(
              event.data
            );

          console.log(
            "DollarTicks ← Deriv:",
            data
          );


          if (data.error) {

            finish(
              reject,
              new Error(
                data.error.message ||
                "Deriv returned an API error."
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
            new Error(
              `Invalid Deriv response: ${error.message}`
            )
          );

        }

      }


      ws.addEventListener(
        "message",
        onMessage
      );


      try {

        console.log(
          "DollarTicks → Deriv:",
          payload
        );

        ws.send(
          JSON.stringify(payload)
        );

      } catch (error) {

        finish(
          reject,
          new Error(
            `Could not send Deriv request: ${error.message}`
          )
        );

      }

    }
  );

}


/* =====================================================
   BUILD PROPOSAL
===================================================== */

function buildProposalRequest({
  market,
  contractType,
  stake,
  duration,
  currency,
  barrier
}) {

  const request = {

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
      "t",

    underlying_symbol:
      market,

    req_id:
      Date.now()

  };


  if (
    contractType === "DIGITOVER" ||
    contractType === "DIGITUNDER" ||
    contractType === "DIGITMATCH" ||
    contractType === "DIGITDIFF"
  ) {

    request.barrier =
      String(barrier);

  }


  return request;
}


/* =====================================================
   OPEN AUTHENTICATED SESSION
===================================================== */

async function openTradingSession(
  token,
  accountId
) {

  /*
   * Get a fresh OTP.
   */

  const wsUrl =
    await getOTP(
      token,
      accountId
    );


  /*
   * Immediately use the OTP.
   */

  const ws =
    await connectDerivWebSocket(
      wsUrl
    );


  /*
   * Wait until connection is open.
   */

  if (
    ws.readyState ===
    WebSocket.OPEN
  ) {

    return ws;

  }


  return new Promise(
    (resolve, reject) => {

      const timeout =
        setTimeout(
          () => {

            reject(
              new Error(
                "Deriv WebSocket did not open."
              )
            );

          },
          10000
        );


      ws.addEventListener(
        "open",
        () => {

          clearTimeout(
            timeout
          );

          resolve(ws);

        },
        { once: true }
      );


      ws.addEventListener(
        "error",
        () => {

          clearTimeout(
            timeout
          );

          reject(
            new Error(
              "Deriv trading WebSocket connection failed."
            )
          );

        },
        { once: true }
      );

    }
  );

}


/* =====================================================
   MAIN
===================================================== */

export async function onRequest(context) {

  const request =
    context.request;


  /* ===================================================
     AUTH TOKEN
  =================================================== */

  const token =
    getCookie(
      request,
      "dt_access_token"
    );


  if (!token) {

    return json(
      {
        ok:
          false,

        connected:
          false,

        error:
          "Deriv account not connected. Please connect Deriv first."
      },
      401
    );

  }


  /* ===================================================
     REQUEST BODY
  =================================================== */

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
          ok:
            false,

          error:
            "Invalid JSON request."
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
    body.account_type ===
      "demo" ||
    body.account_type ===
      "real"
  ) {

    requestedType =
      body.account_type;

  }


  /* ===================================================
     ACCOUNT
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
        ok:
          false,

        connected:
          true,

        error:
          error.message
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
  =================================================== */

  if (
    request.method ===
    "GET"
  ) {

    return json({

      ok:
        true,

      connected:
        true,

      selected_account: {

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
     METHOD
  =================================================== */

  if (
    request.method !==
    "POST"
  ) {

    return json(
      {
        ok:
          false,

        error:
          "Method not allowed."
      },
      405
    );

  }


  /* ===================================================
     BALANCE
  =================================================== */

  if (
    body.action ===
    "balance"
  ) {

    return json({

      ok:
        true,

      balance:
        balance,

      currency:
        currency,

      account: {

        account_id:
          accountId,

        account_type:
          accountType

      }

    });

  }


  /* ===================================================
     SWITCH ACCOUNT
  =================================================== */

  if (
    body.action ===
      "select_account" ||

    body.action ===
      "switch_account"
  ) {

    const type =
      body.account_type ===
      "real"
        ? "real"
        : "demo";


    try {

      const switched =
        await getSelectedAccount(
          token,
          type
        );


      return json({

        ok:
          true,

        message:
          `${type.toUpperCase()} account selected.`,

        account: {

          account_id:
            switched.accountId,

          account_type:
            switched.accountType,

          balance:
            switched.balance,

          currency:
            switched.currency,

          status:
            switched.account.status ||
            "active"

        }

      });

    } catch (error) {

      return json(
        {
          ok:
            false,

          error:
            error.message
        },
        404
      );

    }

  }


  /* ===================================================
     TRADE PARAMETERS
  =================================================== */

  const market =
    body.market ||
    body.symbol ||
    body.underlying_symbol ||
    "1HZ100V";


  const contractType =
    body.contract_type ||
    "DIGITOVER";


  const stake =
    Number(
      body.stake ??
      1
    );


  const duration =
    Number(
      body.duration ??
      1
    );


  const barrier =
    String(
      body.barrier ??
      "5"
    );


  /* ===================================================
     VALIDATION
  =================================================== */

  if (
    !Number.isFinite(stake) ||
    stake <= 0
  ) {

    return json(
      {
        ok:
          false,

        error:
          "Invalid stake."
      },
      400
    );

  }


  if (
    !Number.isInteger(duration) ||
    duration < 1
  ) {

    return json(
      {
        ok:
          false,

        error:
          "Invalid duration."
      },
      400
    );

  }


  /* ===================================================
     BUY
     
     ONE BUTTON:
     
     BUY
       ↓
     Fresh OTP
       ↓
     Authenticated WebSocket
       ↓
     Fresh proposal
       ↓
     Buy proposal
       ↓
     Contract purchased
  =================================================== */

  if (
    body.action ===
    "buy"
  ) {

    if (
      stake >
      balance
    ) {

      return json(
        {
          ok:
            false,

          error:
            "Insufficient account balance.",

          balance:
            balance,

          currency:
            currency
        },
        400
      );

    }


    let ws = null;


    try {

      /*
       * STEP 1:
       * Create ONE fresh authenticated
       * WebSocket connection.
       */

      ws =
        await openTradingSession(
          token,
          accountId
        );


      /*
       * STEP 2:
       * Get proposal on THIS connection.
       */

      const proposalRequest =
        buildProposalRequest({
          market,
          contractType,
          stake,
          duration,
          currency,
          barrier
        });


      const proposalResult =
        await sendAndWait(
          ws,
          proposalRequest,
          "proposal"
        );


      const proposal =
        proposalResult?.proposal;


      if (
        !proposal ||
        !proposal.id
      ) {

        throw new Error(
          "Deriv returned an incomplete proposal."
        );

      }


      const proposalId =
        String(
          proposal.id
        );


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


      /*
       * STEP 3:
       * BUY THE FRESH PROPOSAL ON THE
       * SAME AUTHENTICATED CONNECTION.
       */

      const buyResult =
        await sendAndWait(
          ws,

          {
            buy:
              proposalId,

            price:
              askPrice,

            req_id:
              Date.now()

          },

          "buy"
        );


      const buy =
        buyResult?.buy;


      if (
        !buy ||
        !buy.contract_id
      ) {

        throw new Error(
          "Deriv returned an incomplete purchase response."
        );

      }


      /*
       * STEP 4:
       * SUCCESS
       */

      return json({

        ok:
          true,

        message:
          "Contract purchased successfully.",

        account: {

          account_id:
            accountId,

          account_type:
            accountType,

          currency:
            currency

        },

        contract: {

          contract_id:
            buy.contract_id,

          buy_price:
            buy.buy_price ??
            askPrice,

          payout:
            buy.payout ??
            proposal.payout ??
            null,

          start_time:
            buy.start_time ??
            null,

          purchase_time:
            buy.purchase_time ??
            null

        }

      });


    } catch (error) {

      console.error(
        "DollarTicks BUY ERROR:",
        error
      );


      return json(
        {
          ok:
            false,

          error:
            error.message,

          account: {

            account_id:
              accountId,

            account_type:
              accountType,

            balance:
              balance,

            currency:
              currency

          },

          market:
            market,

          contract_type:
            contractType

        },
        502
      );


    } finally {

      /*
       * Close the single connection after
       * the proposal + buy sequence.
       */

      try {

        if (ws) {
          ws.close();
        }

      } catch {}

    }

  }


  /* ===================================================
     PROPOSAL ONLY
     
     Kept for testing.
  =================================================== */

  if (
    body.action ===
    "proposal"
  ) {

    let ws = null;


    try {

      ws =
        await openTradingSession(
          token,
          accountId
        );


      const result =
        await sendAndWait(

          ws,

          buildProposalRequest({
            market,
            contractType,
            stake,
            duration,
            currency,
            barrier
          }),

          "proposal"

        );


      const proposal =
        result?.proposal;


      if (
        !proposal ||
        !proposal.id
      ) {

        throw new Error(
          "Deriv returned an incomplete proposal."
        );

      }


      return json({

        ok:
          true,

        proposal: {

          id:
            proposal.id,

          ask_price:
            proposal.ask_price ??
            null,

          payout:
            proposal.payout ??
            null,

          spot:
            proposal.spot ??
            null

        }

      });


    } catch (error) {

      return json(
        {
          ok:
            false,

          error:
            error.message
        },
        502
      );


    } finally {

      try {

        if (ws) {
          ws.close();
        }

      } catch {}

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
      String(
        body.contract_id ||
        ""
      );


    if (!contractId) {

      return json(
        {
          ok:
            false,

          error:
            "Missing contract ID."
        },
        400
      );

    }


    let ws = null;


    try {

      ws =
        await openTradingSession(
          token,
          accountId
        );


      const result =
        await sendAndWait(

          ws,

          {
            proposal_open_contract:
              1,

            contract_id:
              Number(contractId),

            req_id:
              Date.now()

          },

          "proposal_open_contract"

        );


      const contract =
        result?.proposal_open_contract;


      if (!contract) {

        throw new Error(
          "Deriv returned no contract information."
        );

      }


      const profit =
        Number(
          contract.profit ??
          0
        );


      const isSold =
        Boolean(
          contract.is_sold
        );


      const derivStatus =
        String(
          contract.status ||
          ""
        ).toLowerCase();


      let status =
        "OPEN";


      if (
        derivStatus.includes(
          "won"
        )
      ) {

        status =
          "WON";

      } else if (
        derivStatus.includes(
          "lost"
        )
      ) {

        status =
          "LOST";

      } else if (
        isSold
      ) {

        status =
          profit > 0
            ? "WON"
            : "LOST";

      }


      return json({

        ok:
          true,

        contract: {

          contract_id:
            contract.contract_id ??
            contractId,

          status:
            status,

          deriv_status:
            contract.status ??
            null,

          is_sold:
            isSold,

          profit:
            Number.isFinite(
              profit
            )
              ? profit
              : null,

          buy_price:
            contract.buy_price ??
            null,

          payout:
            contract.payout ??
            null,

          current_spot:
            contract.current_spot ??
            null,

          exit_spot:
            contract.exit_spot ??
            null,

          exit_spot_time:
            contract.exit_spot_time ??
            null

        }

      });


    } catch (error) {

      return json(
        {
          ok:
            false,

          error:
            error.message,

          contract_id:
            contractId
        },
        502
      );


    } finally {

      try {

        if (ws) {
          ws.close();
        }

      } catch {}

    }

  }


  /* ===================================================
     UNKNOWN ACTION
  =================================================== */

  return json(
    {
      ok:
        false,

      error:
        `Unknown action: ${body.action || "none"}`
    },
    400
  );

}
