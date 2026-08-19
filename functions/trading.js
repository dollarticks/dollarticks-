const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";


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


function getCookie(request, name) {

  const cookies =
    request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {

    const index =
      part.indexOf("=");

    if (index === -1) continue;

    const key =
      part.slice(0, index).trim();

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


/* =========================================
   FIND ACCOUNTS
========================================= */

function findAccounts(value) {

  const accounts = [];

  function scan(item) {

    if (!item) return;

    if (Array.isArray(item)) {

      item.forEach(scan);

      return;

    }

    if (
      typeof item !== "object"
    ) return;


    if (
      item.account_id ||
      item.loginid ||
      item.id
    ) {

      accounts.push(item);

    }


    Object.values(item)
      .forEach(child => {

        if (
          child &&
          typeof child === "object"
        ) {

          scan(child);

        }

      });

  }


  scan(value);


  const seen =
    new Set();


  return accounts.filter(
    account => {

      const id =
        account.account_id ||
        account.loginid ||
        account.id;


      if (!id) return false;


      const key =
        String(id);


      if (seen.has(key))
        return false;


      seen.add(key);

      return true;

    }
  );

}


/* =========================================
   GET OPTIONS ACCOUNTS
========================================= */

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


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not retrieve Options accounts."
    );

  }


  return findAccounts(data);

}


/* =========================================
   GET OTP / WEBSOCKET URL
========================================= */

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


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not create trading session."
    );

  }


  if (!data?.data?.url) {

    throw new Error(
      "Deriv did not return a WebSocket URL."
    );

  }


  return data.data.url;

}


/* =========================================
   WEBSOCKET REQUEST
========================================= */

function wsRequest(
  wsUrl,
  request,
  expectedType
) {

  return new Promise(
    (resolve, reject) => {

      let ws = null;

      let finished =
        false;


      const timeout =
        setTimeout(
          () => {

            finish(
              reject,
              new Error(
                "Deriv request timed out."
              )
            );

          },
          15000
        );


      function finish(
        callback,
        value
      ) {

        if (finished)
          return;


        finished = true;

        clearTimeout(timeout);


        try {

          ws?.close();

        } catch {}


        callback(value);

      }


      try {

        ws =
          new WebSocket(
            wsUrl
          );

      } catch (error) {

        finish(
          reject,
          error
        );

        return;

      }


      ws.onopen =
        () => {

          console.log(
            "DollarTicks → Deriv:",
            request
          );


          ws.send(
            JSON.stringify(
              request
            )
          );

        };


      ws.onmessage =
        event => {

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
                  JSON.stringify(
                    data.error
                  )
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
              error
            );

          }

        };


      ws.onerror =
        () => {

          finish(
            reject,
            new Error(
              "Trading WebSocket connection failed."
            )
          );

        };


      ws.onclose =
        () => {

          if (!finished) {

            finish(
              reject,
              new Error(
                "Trading WebSocket closed unexpectedly."
              )
            );

          }

        };

    }
  );

}


/* =========================================
   MAIN
========================================= */

export async function onRequest(
  context
) {

  const request =
    context.request;


  const token =
    getCookie(
      request,
      "dt_access_token"
    );


  /* =======================================
     LOGIN CHECK
  ======================================= */

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


  /* =======================================
     GET ACCOUNTS
  ======================================= */

  let accounts;


  try {

    accounts =
      await getAccounts(
        token
      );

  } catch (error) {

    return json(
      {
        ok: false,
        connected: false,
        error:
          error.message
      },
      401
    );

  }


  if (!accounts.length) {

    return json(
      {
        ok: false,
        connected: false,
        error:
          "No Deriv Options account found."
      }
    );

  }


  /*
   * IMPORTANT:
   *
   * Prefer an account whose actual ID
   * starts with DOT.
   */

  const selected =
    accounts.find(
      account => {

        const id =
          account.account_id ||
          account.loginid ||
          account.id ||
          "";

        return String(id)
          .toUpperCase()
          .startsWith("DOT");

      }
    ) ||
    accounts.find(
      account =>
        String(
          account.account_type ||
          ""
        ).toLowerCase() ===
        "demo"
    ) ||
    accounts[0];


  const accountId =
    selected.account_id ||
    selected.loginid ||
    selected.id;


  const accountType =
    String(
      selected.account_type ||
      "demo"
    ).toLowerCase();


  const currency =
    selected.currency ||
    "USD";


  /* =======================================
     GET /trading
  ======================================= */

  if (
    request.method ===
    "GET"
  ) {

    return json({

      ok: true,

      connected: true,

      selected_account: {

        account_id:
          accountId,

        account_type:
          accountType,

        currency:
          currency

      }

    });

  }


  /* =======================================
     ONLY POST ALLOWED
  ======================================= */

  if (
    request.method !==
    "POST"
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


  /* =======================================
     READ BODY
  ======================================= */

  let body;


  try {

    body =
      await request.json();

  } catch {

    return json(
      {
        ok: false,
        error:
          "Invalid JSON request."
      },
      400
    );

  }


  const action =
    body.action;


  /* =======================================
     MARKET
  ======================================= */

  const market =
    body.market ||
    body.underlying_symbol ||
    "1HZ100V";


  /* =======================================
     CONTRACT
  ======================================= */

  const contractType =
    body.contract_type ||
    "DIGITOVER";


  /* =======================================
     STAKE
  ======================================= */

  const stake =
    Number(body.stake);


  if (
    !Number.isFinite(stake) ||
    stake <= 0
  ) {

    return json(
      {
        ok: false,
        error:
          "Invalid stake."
      },
      400
    );

  }


  /* =======================================
     DURATION
  ======================================= */

  const duration =
    Number(body.duration);


  if (
    !Number.isInteger(duration) ||
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


  /* =======================================
     BARRIER
  ======================================= */

  const barrier =
    String(
      body.barrier ?? "5"
    );


  /* =======================================
     GET AUTHENTICATED WEBSOCKET
  ======================================= */

  let wsUrl;


  try {

    wsUrl =
      await getOTP(
        token,
        accountId
      );

  } catch (error) {

    return json(
      {
        ok: false,
        error:
          error.message
      },
      502
    );

  }


  /* =======================================
     PROPOSAL
  ======================================= */

  if (
    action ===
    "proposal"
  ) {

    /*
     * Current Deriv API format.
     *
     * NO "symbol".
     * NO loginid.
     * NO subscribe for now.
     */

    const proposalRequest = {

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
        "t",

      underlying_symbol:
        market,

      barrier:
        barrier,

      req_id:
        2001

    };


    try {

      const result =
        await wsRequest(
          wsUrl,
          proposalRequest,
          "proposal"
        );


      const proposal =
        result?.proposal;


      /*
       * Show the complete Deriv
       * response if something is
       * missing.
       */

      if (
        !proposal ||
        !proposal.id
      ) {

        return json(
          {
            ok: false,

            error:
              "Deriv returned an incomplete proposal.",

            account: {
              account_id:
                accountId,

              account_type:
                accountType,

              currency:
                currency
            },

            market:
              market,

            contract_type:
              contractType,

            raw:
              result

          },
          502
        );

      }


      return json({

        ok: true,

        proposal: {

          id:
            String(
              proposal.id
            ),

          ask_price:
            proposal.ask_price ??
            null,

          payout:
            proposal.payout ??
            null,

          spot:
            proposal.spot ??
            null,

          display_value:
            proposal.display_value ??
            null

        }

      });

    } catch (error) {

      console.error(
        "PROPOSAL ERROR:",
        error
      );


      return json(
        {
          ok: false,

          error:
            error.message,

          account: {
            account_id:
              accountId,

            account_type:
              accountType,

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

    }

  }


  /* =======================================
     BUY
  ======================================= */

  if (
    action ===
    "buy"
  ) {

    if (
      accountType !==
      "demo"
    ) {

      return json(
        {
          ok: false,
          error:
            "Only the DEMO account can purchase contracts."
        },
        403
      );

    }


    const proposalId =
      String(
        body.proposal_id ||
        ""
      );


    const price =
      Number(
        body.price
      );


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


    const buyRequest = {

      buy:
        proposalId,

      price:
        price,

      req_id:
        3001

    };


    try {

      const result =
        await wsRequest(
          wsUrl,
          buyRequest,
          "buy"
        );


      const contract =
        result?.buy;


      if (
        !contract ||
        !contract.contract_id
      ) {

        return json(
          {
            ok: false,

            error:
              "Deriv returned an incomplete purchase response.",

            raw:
              result
          },
          502
        );

      }


      return json({

        ok: true,

        contract: {

          contract_id:
            contract.contract_id,

          buy_price:
            contract.buy_price ??
            null,

          payout:
            contract.payout ??
            null,

          start_time:
            contract.start_time ??
            null,

          purchase_time:
            contract.purchase_time ??
            null

        }

      });

    } catch (error) {

      console.error(
        "BUY ERROR:",
        error
      );


      return json(
        {
          ok: false,
          error:
            error.message
        },
        502
      );

    }

  }


  /* =======================================
     UNKNOWN ACTION
  ======================================= */

  return json(
    {
      ok: false,

      error:
        `Unknown action: ${
          action || "none"
        }`

    },
    400
  );

}
