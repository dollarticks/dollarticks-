const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   JSON RESPONSE
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
   GET COOKIE
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
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": CLIENT_ID,
        Accept: "application/json"
      },

      cache: "no-store"
    }
  );

  const data =
    await response.json();

  console.log(
    "DollarTicks OPTIONS ACCOUNTS:",
    data
  );

  if (!response.ok) {

    throw new Error(
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      "Could not retrieve Options accounts."
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
   GET ACCOUNT ID
===================================================== */

function getAccountId(account) {

  return (
    account?.account_id ||
    account?.loginid ||
    account?.id ||
    null
  );

}


/* =====================================================
   GET ACCOUNT TYPE
===================================================== */

function getAccountType(account) {

  return String(
    account?.account_type || "demo"
  ).toLowerCase();

}


/* =====================================================
   GET ACCOUNT BALANCE
===================================================== */

function getAccountBalance(account) {

  const value = Number(
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

  /*
   * First look for exact account type.
   */

  const exact =
    accounts.find(account => {

      return (
        getAccountType(account) === wanted
      );

    });

  if (exact) {
    return exact;
  }

  /*
   * Fallback to demo if requested account
   * does not exist.
   */

  const demo =
    accounts.find(account => {

      return (
        getAccountType(account) === "demo"
      );

    });

  return demo || accounts[0];

}


/* =====================================================
   GET AUTHENTICATED WEBSOCKET URL
===================================================== */

async function getOTP(
  token,
  accountId
) {

  const response = await fetch(

    `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,

    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": CLIENT_ID,
        Accept: "application/json"
      },

      cache: "no-store"
    }

  );

  const data =
    await response.json();

  console.log(
    "DollarTicks OTP RESPONSE:",
    data
  );

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


/* =====================================================
   WEBSOCKET REQUEST
===================================================== */

function wsRequest(
  wsUrl,
  payload,
  expectedType
) {

  return new Promise(
    (resolve, reject) => {

      let ws = null;

      let finished = false;

      const timeout =
        setTimeout(() => {

          finish(
            reject,
            new Error(
              "Deriv request timed out."
            )
          );

        }, 15000);


      function finish(
        callback,
        value
      ) {

        if (finished) return;

        finished = true;

        clearTimeout(timeout);

        try {

          ws?.close();

        } catch {}

        callback(value);

      }


      try {

        ws =
          new WebSocket(wsUrl);

      } catch (error) {

        finish(
          reject,
          error
        );

        return;

      }


      ws.onopen = () => {

        console.log(
          "DollarTicks → Deriv:",
          payload
        );

        ws.send(
          JSON.stringify(payload)
        );

      };


      ws.onmessage = event => {

        try {

          const data =
            JSON.parse(event.data);

          console.log(
            "DollarTicks ← Deriv:",
            data
          );

          if (data.error) {

            finish(
              reject,
              new Error(
                data.error.message ||
                JSON.stringify(data.error)
              )
            );

            return;

          }

          if (
            data.msg_type === expectedType
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


      ws.onerror = () => {

        finish(
          reject,
          new Error(
            "Trading WebSocket connection failed."
          )
        );

      };


      ws.onclose = () => {

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


/* =====================================================
   MAIN HANDLER
===================================================== */

export async function onRequest(context) {

  const request =
    context.request;


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

        connected: false,

        error:
          "Deriv account is not connected."
      },

      401
    );

  }


  /* ===================================================
     GET ALL OPTIONS ACCOUNTS
  =================================================== */

  let accounts;

  try {

    accounts =
      await getAccounts(token);

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


  console.log(
    "DollarTicks FOUND OPTIONS ACCOUNTS:",
    accounts
  );


  if (!accounts.length) {

    return json(
      {
        ok: false,

        connected: true,

        error:
          "No Deriv Options account found."
      },

      404
    );

  }


  /* ===================================================
     DETERMINE REQUESTED ACCOUNT TYPE
  =================================================== */

  let requestedType = "demo";


  /*
   * GET can use:
   *
   * /trading?account_type=real
   *
   * POST can send:
   *
   * {
   *   account_type:"real"
   * }
   */

  try {

    if (request.method === "GET") {

      const url =
        new URL(request.url);

      const queryType =
        url.searchParams.get(
          "account_type"
        );

      if (
        queryType === "real" ||
        queryType === "demo"
      ) {

        requestedType =
          queryType;

      }

    }

  } catch {}


  /* ===================================================
     READ POST BODY EARLY
  =================================================== */

  let body = {};

  if (request.method === "POST") {

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

    if (
      body.account_type === "real" ||
      body.account_type === "demo"
    ) {

      requestedType =
        body.account_type;

    }

  }


  /* ===================================================
     SELECT ACCOUNT
  =================================================== */

  const selected =
    findAccount(
      accounts,
      requestedType
    );


  if (!selected) {

    return json(
      {
        ok: false,

        connected: true,

        error:
          "No usable Deriv Options account found."
      },

      404
    );

  }


  const accountId =
    getAccountId(selected);


  const accountType =
    getAccountType(selected);


  const currency =
    selected.currency ||
    "USD";


  const balance =
    getAccountBalance(selected);


  if (!accountId) {

    return json(
      {
        ok: false,

        connected: true,

        error:
          "Deriv returned an account without an account ID.",

        account:
          selected
      },

      502
    );

  }


  /* ===================================================
     AVAILABLE ACCOUNTS FOR SWITCHER
  =================================================== */

  const availableAccounts =
    accounts.map(account => {

      const id =
        getAccountId(account);

      const type =
        getAccountType(account);

      const balance =
        getAccountBalance(account);

      return {

        account_id:
          id,

        account_type:
          type,

        balance:
          balance,

        currency:
          account.currency ||
          "USD",

        status:
          account.status ||
          "active"

      };

    });


  /* ===================================================
     GET REQUEST
  =================================================== */

  if (request.method === "GET") {

    return json({

      ok: true,

      connected: true,

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
          selected.status ||
          "active"

      },

      accounts:
        availableAccounts

    });

  }


  /* ===================================================
     ONLY POST BELOW
  =================================================== */

  if (request.method !== "POST") {

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
     ACTION
  =================================================== */

  const action =
    body.action;


  /* ===================================================
     SWITCH ACCOUNT
  =================================================== */

  if (action === "switch_account") {

    const switchType =
      body.account_type === "real"
        ? "real"
        : "demo";


    const switchAccount =
      findAccount(
        accounts,
        switchType
      );


    if (!switchAccount) {

      return json(
        {
          ok: false,

          error:
            `No ${switchType.toUpperCase()} Options account found.`
        },

        404
      );

    }


    const switchId =
      getAccountId(
        switchAccount
      );


    return json({

      ok: true,

      message:
        `${switchType.toUpperCase()} account selected.`,

      selected_account: {

        account_id:
          switchId,

        account_type:
          getAccountType(
            switchAccount
          ),

        balance:
          getAccountBalance(
            switchAccount
          ),

        currency:
          switchAccount.currency ||
          "USD",

        status:
          switchAccount.status ||
          "active"

      }

    });

  }


  /* ===================================================
     REFRESH BALANCE
  =================================================== */

  if (action === "balance") {

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
     MARKET
  =================================================== */

  const market =
    body.market ||
    body.underlying_symbol ||
    "1HZ100V";


  /* ===================================================
     CONTRACT
  =================================================== */

  const contractType =
    body.contract_type ||
    "DIGITOVER";


  /* ===================================================
     STAKE
  =================================================== */

  const stake =
    Number(
      body.stake ?? 1
    );


  /* ===================================================
     DURATION
  =================================================== */

  const duration =
    Number(
      body.duration ?? 1
    );


  /* ===================================================
     BARRIER
  =================================================== */

  const barrier =
    String(
      body.barrier ?? "5"
    );


  /* ===================================================
     CONTRACT STATUS
  =================================================== */

  if (
    action ===
    "contract_status"
  ) {

    const contractId =
      String(
        body.contract_id || ""
      );


    if (!contractId) {

      return json(
        {
          ok: false,

          error:
            "Missing contract ID."
        },

        400
      );

    }


    let statusWsUrl;

    try {

      statusWsUrl =
        await getOTP(
          token,
          accountId
        );

    } catch (error) {

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

            balance:
              balance,

            currency:
              currency

          }

        },

        502
      );

    }


    const contractRequest = {

      proposal_open_contract:
        1,

      contract_id:
        Number(contractId),

      req_id:
        Date.now()

    };


    try {

      const result =
        await wsRequest(
          statusWsUrl,
          contractRequest,
          "proposal_open_contract"
        );


      const contract =
        result?.proposal_open_contract;


      if (!contract) {

        return json(
          {
            ok: false,

            error:
              "Deriv returned no contract information.",

            raw:
              result
          },

          502
        );

      }


      const profit =
        Number(
          contract.profit ?? 0
        );


      const buyPrice =
        Number(
          contract.buy_price ?? 0
        );


      const payout =
        Number(
          contract.payout ?? 0
        );


      const isSold =
        Boolean(
          contract.is_sold
        );


      let resultStatus =
        "OPEN";


      if (contract.status) {

        const derivStatus =
          String(
            contract.status
          ).toLowerCase();


        if (
          derivStatus.includes(
            "won"
          )
        ) {

          resultStatus =
            "WON";

        } else if (
          derivStatus.includes(
            "lost"
          )
        ) {

          resultStatus =
            "LOST";

        } else if (
          derivStatus.includes(
            "sold"
          )
        ) {

          resultStatus =
            profit > 0
              ? "WON"
              : "LOST";

        } else if (
          derivStatus.includes(
            "open"
          )
        ) {

          resultStatus =
            "OPEN";

        }

      }


      if (
        isSold &&
        resultStatus === "OPEN"
      ) {

        resultStatus =
          profit > 0
            ? "WON"
            : "LOST";

      }


      return json({

        ok: true,

        contract: {

          contract_id:
            contract.contract_id ??
            contractId,

          status:
            resultStatus,

          deriv_status:
            contract.status ??
            null,

          is_sold:
            isSold,

          profit:
            Number.isFinite(profit)
              ? profit
              : null,

          buy_price:
            Number.isFinite(buyPrice)
              ? buyPrice
              : null,

          payout:
            Number.isFinite(payout)
              ? payout
              : null,

          current_spot:
            contract.current_spot ??
            null,

          exit_spot:
            contract.exit_spot ??
            null,

          exit_spot_time:
            contract.exit_spot_time ??
            null

        },

        account: {

          account_id:
            accountId,

          account_type:
            accountType,

          balance:
            balance,

          currency:
            currency

        }

      });

    } catch (error) {

      return json(
        {
          ok: false,

          error:
            error.message,

          contract_id:
            contractId
        },

        502
      );

    }

  }


  /* ===================================================
     VALIDATION
  =================================================== */

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


  /* ===================================================
     GET AUTHENTICATED WEBSOCKET
  =================================================== */

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

        }

      },

      502
    );

  }


  /* ===================================================
     PROPOSAL
  =================================================== */

  if (
    action ===
    "proposal"
  ) {

    const proposalRequest = {

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

      barrier:
        barrier,

      req_id:
        Date.now()

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

              balance:
                balance,

              currency:
                currency

            },

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

        },

        trade_parameters: {

          market:
            market,

          contract_type:
            contractType,

          stake:
            stake,

          duration:
            duration,

          duration_unit:
            "t",

          barrier:
            barrier,

          currency:
            currency

        },

        account: {

          account_id:
            accountId,

          account_type:
            accountType,

          balance:
            balance,

          currency:
            currency

        }

      });

    } catch (error) {

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

            balance:
              balance,

            currency:
              currency

          }

        },

        502
      );

    }

  }


  /* ===================================================
     BUY CONTRACT
  =================================================== */

  if (
    action === "buy"
  ) {

    /*
     * The old version blocked REAL.
     *
     * We are removing that restriction so the
     * selected account can be used.
     *
     * The frontend should clearly show DEMO/REAL
     * before purchasing.
     */


    if (
      stake > balance
    ) {

      return json(
        {
          ok: false,

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


    const buyRequest = {

      buy:
        "1",

      price:
        stake,

      parameters: {

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
          barrier

      },

      req_id:
        Date.now()

    };


    try {

      const result =
        await wsRequest(
          wsUrl,
          buyRequest,
          "buy"
        );


      const buy =
        result?.buy;


      if (
        !buy ||
        !buy.contract_id
      ) {

        return json(
          {
            ok: false,

            error:
              "Deriv returned an incomplete purchase response.",

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

            raw:
              result

          },

          502
        );

      }


      return json({

        ok: true,

        message:
          `${accountType.toUpperCase()} contract purchased successfully.`,

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

        contract: {

          contract_id:
            buy.contract_id,

          buy_price:
            buy.buy_price ??
            null,

          payout:
            buy.payout ??
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

    }

  }


  /* ===================================================
     UNKNOWN ACTION
  =================================================== */

  return json(
    {
      ok: false,

      error:
        `Unknown action: ${action || "none"}`
    },

    400
  );

        }
