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
   GET OPTIONS ACCOUNTS
===================================================== */

async function getAccounts(token) {

  const response = await fetch(
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
    account?.account_type || "demo"
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
   FIND ACCOUNT
===================================================== */

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


/* =====================================================
   GET SELECTED ACCOUNT
===================================================== */

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
      `No ${String(requestedType).toUpperCase()} trading account is available.`
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
   GET AUTHENTICATED WEBSOCKET URL
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
    "DollarTicks OTP STATUS:",
    response.status
  );


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


  /*
   * Deriv returns:
   *
   * data.url
   *
   * The URL already contains the OTP.
   */

  const wsUrl =
    data?.data?.url;


  if (!wsUrl) {

    throw new Error(
      "Trading service did not return an authenticated WebSocket URL."
    );

  }


  if (
    !String(wsUrl).startsWith("wss://")
  ) {

    throw new Error(
      "Trading service returned an invalid WebSocket URL."
    );

  }


  return wsUrl;

}


/* =====================================================
   WEBSOCKET REQUEST
===================================================== */

function wsRequest(
  wsUrl,
  payload,
  wantedMsgType
) {

  return new Promise(
    (resolve, reject) => {

      let ws = null;

      let finished = false;

      const timeout =
        setTimeout(
          () => {

            if (finished)
              return;

            finished = true;

            try {

              ws?.close();

            } catch {}

            reject(
              new Error(
                "Trading service timed out while processing the request."
              )
            );

          },
          20000
        );


      function cleanup() {

        clearTimeout(
          timeout
        );

      }


      function fail(message) {

        if (finished)
          return;

        finished = true;

        cleanup();

        try {

          ws?.close();

        } catch {}

        reject(
          new Error(
            message
          )
        );

      }


      function success(data) {

        if (finished)
          return;

        finished = true;

        cleanup();

        try {

          ws?.close();

        } catch {}

        resolve(
          data
        );

      }


      try {

        console.log(
          "DollarTicks opening WebSocket..."
        );


        ws =
          new WebSocket(
            wsUrl
          );


      } catch (error) {

        console.error(
          "DollarTicks WebSocket constructor error:",
          error
        );

        fail(
          "Could not open the trading connection."
        );

        return;

      }


      ws.addEventListener(
        "open",
        () => {

          console.log(
            "DollarTicks WebSocket connected."
          );


          try {

            ws.send(
              JSON.stringify(
                payload
              )
            );


            console.log(
              "DollarTicks WebSocket request sent:",
              payload
            );


          } catch (error) {

            console.error(
              "DollarTicks WebSocket send error:",
              error
            );

            fail(
              "Could not send the trading request."
            );

          }

        }
      );


      ws.addEventListener(
        "message",
        event => {

          let data;


          try {

            data =
              JSON.parse(
                event.data
              );

          } catch {

            console.log(
              "DollarTicks received non-JSON WebSocket message."
            );

            return;

          }


          console.log(
            "DollarTicks WebSocket response:",
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
            wantedMsgType
          ) {

            success(
              data
            );

          }

        }
      );


      ws.addEventListener(
        "error",
        event => {

          console.error(
            "DollarTicks WebSocket ERROR:",
            event
          );


          fail(
            "Trading connection failed."
          );

        }
      );


      ws.addEventListener(
        "close",
        event => {

          console.log(
            "DollarTicks WebSocket CLOSED:",
            event.code,
            event.reason
          );


          if (!finished) {

            fail(
              "Trading connection closed unexpectedly."
            );

          }

        }
      );

    }
  );

}


/* =====================================================
   PROPOSAL
===================================================== */

async function getProposal(
  wsUrl,
  payload
) {

  const data =
    await wsRequest(
      wsUrl,
      payload,
      "proposal"
    );


  const proposal =
    data?.proposal;


  if (!proposal?.id) {

    throw new Error(
      "Deriv did not return a valid proposal."
    );

  }


  return proposal;

}


/* =====================================================
   BUY CONTRACT
===================================================== */

async function buyContract(
  wsUrl,
  proposalId,
  price
) {

  const data =
    await wsRequest(
      wsUrl,

      {
        buy:
          String(proposalId),

        price:
          Number(price),

        req_id:
          2
      },

      "buy"
    );


  const buy =
    data?.buy;


  if (!buy?.contract_id) {

    throw new Error(
      "Deriv did not return a contract ID."
    );

  }


  return buy;

}


/* =====================================================
   CONTRACT STATUS
===================================================== */

async function getContractStatus(
  wsUrl,
  contractId
) {

  const data =
    await wsRequest(

      wsUrl,

      {
        proposal_open_contract:
          1,

        contract_id:
          Number(contractId),

        subscribe:
          1,

        req_id:
          3
      },

      "proposal_open_contract"

    );


  return (
    data?.proposal_open_contract ||
    {}
  );

}


/* =====================================================
   MAIN
===================================================== */

export async function onRequest(
  context
) {

  const request =
    context.request;


  /* ===================================================
     METHODS
  =================================================== */

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
     AUTHENTICATION
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

        connected: false,

        error:
          "Trading session is unavailable. Please try again."
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
     ACCOUNT SWITCH
  =================================================== */

  if (
    body.action === "select_account" ||
    body.action === "switch_account"
  ) {

    const type =
      body.account_type === "real"
        ? "real"
        : "demo";


    try {

      const switched =
        await getSelectedAccount(
          token,
          type
        );


      return json({

        ok: true,

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
          ok: false,

          error:
            error.message
        },
        404
      );

    }

  }


  /* ===================================================
     BALANCE
  =================================================== */

  if (
    body.action === "balance"
  ) {

    return json({

      ok: true,

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
     TRADING SESSION TEST
  =================================================== */

  if (
    body.action === "session" ||
    body.action === "trading_session"
  ) {

    try {

      /*
       * Request a fresh OTP.
       *
       * The returned URL is valid for
       * only a short period and is
       * single-use.
       */

      const wsUrl =
        await getOTP(
          token,
          accountId
        );


      /*
       * Actually open the connection
       * to verify it works.
       *
       * We use a balance request as
       * the first authenticated message.
       */

      const test =
        await wsRequest(

          wsUrl,

          {
            balance:
              1,

            req_id:
              10
          },

          "balance"

        );


      return json({

        ok: true,

        connected: true,

        trading_ready: true,

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

    }

  }


  /* ===================================================
     BUY
  =================================================== */

  if (
    body.action === "buy"
  ) {

    try {

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
        );


      /*
       * Get a NEW authenticated
       * WebSocket URL immediately
       * before trading.
       */

      const wsUrl =
        await getOTP(
          token,
          accountId
        );


      /* =================================================
         PROPOSAL
      ================================================= */

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
          1

      };


      /* =================================================
         DIGIT BARRIERS
      ================================================= */

      const digitTypes = [

        "DIGITOVER",

        "DIGITUNDER",

        "DIGITMATCH",

        "DIGITDIFF"

      ];


      if (
        digitTypes.includes(
          contractType
        )
      ) {

        const barrier =
          String(
            body.barrier ??
            "5"
          );


        proposalPayload.barrier =
          barrier;

      }


      /* =================================================
         GET PROPOSAL
      ================================================= */

      const proposal =
        await getProposal(
          wsUrl,
          proposalPayload
        );


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


      /* =================================================
         BUY
      ================================================= */

      const buy =
        await buyContract(
          wsUrl,
          proposal.id,
          askPrice
        );


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
            accountType,

          account_id:
            accountId,

          market:
            market,

          contract_type:
            contractType,

          barrier:
            body.barrier ??
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
          ok: false,

          connected: true,

          error:
            error.message ||
            "Purchase failed."
        },
        400
      );

    }

  }


  /* ===================================================
     CONTRACT STATUS
  =================================================== */

  if (
    body.action === "contract_status"
  ) {

    try {

      const contractId =
        String(
          body.contract_id ||
          ""
        ).trim();


      if (!contractId) {

        throw new Error(
          "No contract ID was supplied."
        );

      }


      const wsUrl =
        await getOTP(
          token,
          accountId
        );


      const contract =
        await getContractStatus(
          wsUrl,
          contractId
        );


      const status =
        String(
          contract.status ||
          (
            contract.is_sold
              ? (
                  Number(
                    contract.profit || 0
                  ) >= 0
                    ? "WON"
                    : "LOST"
                )
              : "OPEN"
          )
        ).toUpperCase();


      return json({

        ok: true,

        contract: {

          contract_id:
            contract.contract_id ||
            contractId,

          status:
            status,

          profit:
            Number(
              contract.profit ||
              0
            ),

          buy_price:
            Number(
              contract.buy_price ||
              0
            ),

          payout:
            Number(
              contract.payout ||
              0
            ),

          current_spot:
            contract.current_spot ??
            null,

          exit_spot:
            contract.exit_spot ??
            null

        }

      });


    } catch (error) {

      console.error(
        "DollarTicks CONTRACT STATUS ERROR:",
        error
      );


      return json(
        {
          ok: false,

          connected: true,

          error:
            error.message ||
            "Could not check contract status."
        },
        400
      );

    }

  }


  /* ===================================================
     UNKNOWN ACTION
  =================================================== */

  return json(
    {
      ok: false,

      error:
        `Unknown action: ${body.action || "none"}`
    },
    400
  );

}
