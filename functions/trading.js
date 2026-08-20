const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";


/* =====================================================
   JSON
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


  let data;

  try {

    data =
      await response.json();

  } catch {

    throw new Error(
      "Deriv returned an invalid account response."
    );

  }


  console.log(
    "DollarTicks OPTIONS ACCOUNTS:",
    data
  );


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
      "No Deriv Options account found."
    );

  }


  const account =
    findAccount(
      accounts,
      requestedType
    );


  if (!account) {

    throw new Error(
      `No ${String(requestedType).toUpperCase()} Options account found.`
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
   CREATE TEMPORARY DERIV WEBSOCKET SESSION
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


  let data;

  try {

    data =
      await response.json();

  } catch {

    throw new Error(
      "Deriv returned an invalid trading-session response."
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
      "Could not create Deriv trading session."
    );

  }


  const wsUrl =
    data?.data?.url;


  if (!wsUrl) {

    throw new Error(
      "Deriv did not return a trading WebSocket URL."
    );

  }


  /*
   * This is a temporary authenticated URL.
   * It is returned to the browser so the browser
   * can connect directly to Deriv's WebSocket.
   */

  return wsUrl;

}


/* =====================================================
   MAIN
===================================================== */

export async function onRequest(context) {

  const request =
    context.request;


  /* ===================================================
     ONLY GET/POST
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
        ok: false,

        connected: false,

        error:
          "Deriv account not connected. Please connect Deriv first."
      },
      401
    );

  }


  /* ===================================================
     READ REQUEST
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

    return json(
      {
        ok: false,

        connected: true,

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
     GET = ACCOUNT INFORMATION
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
===================================================== */

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
===================================================== */

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
     CREATE TRADING WEBSOCKET SESSION
     
     THIS IS THE IMPORTANT PART.

     The Worker does NOT create the WebSocket.

     It only asks Deriv for the temporary
     authenticated WebSocket URL.

     The browser will connect to that URL.
===================================================== */

  if (
    body.action === "session" ||
    body.action === "trading_session" ||
    body.action === "proposal" ||
    body.action === "buy"
  ) {

    try {

      const wsUrl =
        await getOTP(
          token,
          accountId
        );


      return json({

        ok: true,

        connected: true,

        websocket: {

          url:
            wsUrl,

          expires:
            "temporary"

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

      console.error(
        "DollarTicks SESSION ERROR:",
        error
      );


      return json(
        {
          ok: false,

          connected: true,

          error:
            error.message
        },
        502
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
        `Unknown action: ${body.action || "none"}`
    },
    400
  );

    }
