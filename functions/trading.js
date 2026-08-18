export async function onRequest(context) {
  const request = context.request;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });

  const DERIV_API = "https://api.derivws.com";
  const APP_ID = "347btQbpUS2La9uhcLb2X";

  /* =========================
     COOKIE
     ========================= */

  const cookies = request.headers.get("Cookie") || "";

  function getCookie(name) {
    const match = cookies.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]*)")
    );

    return match
      ? decodeURIComponent(match[2])
      : null;
  }

  const accessToken = getCookie("dt_access_token");

  if (!accessToken) {
    return json(
      {
        ok: false,
        connected: false,
        error:
          "No Deriv login session found. Connect Deriv again."
      },
      401
    );
  }

  /* =========================
     GET OPTIONS ACCOUNTS
     ========================= */

  async function getAccounts() {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": APP_ID,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Deriv rejected the account request."
      );
    }

    return data;
  }

  /* =========================
     EXTRACT ACCOUNTS
     ========================= */

  function extractAccounts(data) {
    const found = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
        return;
      }

      if (typeof value !== "object") {
        return;
      }

      if (
        value.account_id ||
        value.loginid ||
        value.id
      ) {
        found.push(value);
      }

      for (const valueItem of Object.values(value)) {
        if (
          valueItem &&
          typeof valueItem === "object"
        ) {
          scan(valueItem);
        }
      }
    }

    scan(data);

    const seen = new Set();

    return found.filter(account => {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) return false;

      const key = String(id);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  /* =========================
     ACCOUNT ID
     ========================= */

  function getAccountId(account) {
    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }

  /* =========================
     FIND DEMO ACCOUNT
     ========================= */

  function findDemoAccount(accounts) {
    return accounts.find(account => {
      const type =
        String(
          account.account_type || ""
        ).toLowerCase();

      const loginid =
        String(
          account.loginid || ""
        ).toLowerCase();

      return (
        type === "demo" ||
        loginid.startsWith("vrt")
      );
    });
  }

  /* =========================
     GET AUTHENTICATED WS URL
     ========================= */

  async function getTradingWebSocketUrl(accountId) {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": APP_ID,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Deriv refused the trading connection."
      );
    }

    const url =
      data.data?.url ||
      data.url;

    if (!url) {
      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    return url;
  }

  /* =========================
     CONNECT WS
     ========================= */

  function openWebSocket(url) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;

          try {
            ws.close();
          } catch {}

          reject(
            new Error(
              "Authenticated Deriv WebSocket connection timed out."
            )
          );
        }
      }, 15000);

      ws.addEventListener(
        "open",
        () => {
          if (settled) return;

          settled = true;
          clearTimeout(timeout);

          resolve(ws);
        },
        { once: true }
      );

      ws.addEventListener(
        "error",
        () => {
          if (settled) return;

          settled = true;
          clearTimeout(timeout);

          reject(
            new Error(
              "Authenticated Deriv WebSocket connection failed."
            )
          );
        },
        { once: true }
      );
    });
  }

  /* =========================
     WS REQUEST
     ========================= */

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeoutMs = 15000
  ) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;

        finished = true;

        reject(
          new Error(
            "Deriv request timed out."
          )
        );
      }, timeoutMs);

      const finish = (callback, value) => {
        if (finished) return;

        finished = true;
        clearTimeout(timeout);

        callback(value);
      };

      const messageHandler = event => {
        try {
          const data =
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : event.data;

          /*
           * IMPORTANT:
           * Return Deriv's REAL error message.
           */

          if (data.error) {
            finish(
              reject,
              new Error(
                data.error.message ||
                data.error.code ||
                "Deriv rejected the request."
              )
            );

            return;
          }

          if (
            data.msg_type ===
            expectedMessage
          ) {
            finish(resolve, data);
          }

        } catch (error) {
          finish(reject, error);
        }
      };

      const errorHandler = () => {
        finish(
          reject,
          new Error(
            "Authenticated Deriv WebSocket connection failed."
          )
        );
      };

      ws.addEventListener(
        "message",
        messageHandler
      );

      ws.addEventListener(
        "error",
        errorHandler,
        { once: true }
      );

      try {
        ws.send(
          JSON.stringify(payload)
        );
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /* =========================
     VALID MARKETS
     ========================= */

  const VALID_MARKETS = [
    "1HZ100V",
    "1HZ75V",
    "1HZ50V",
    "1HZ25V",
    "1HZ10V"
  ];

  /* =========================
     MAIN
     ========================= */

  try {

    /* =========================
       GET
       ========================= */

    if (request.method === "GET") {

      const accountData =
        await getAccounts();

      const accounts =
        extractAccounts(accountData);

      if (!accounts.length) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "No Deriv Options account was returned.",
            deriv_response:
              accountData
          },
          404
        );
      }

      const demo =
        findDemoAccount(accounts);

      return json({
        ok: true,
        connected: true,

        selected_account:
          demo
            ? {
                account_id:
                  getAccountId(demo),

                loginid:
                  demo.loginid || null,

                account_type:
                  "demo",

                currency:
                  demo.currency || "USD",

                status:
                  demo.status || "active",

                balance:
                  demo.balance ?? null
              }
            : null,

        accounts:
          accounts.map(account => ({
            account_id:
              getAccountId(account),

            loginid:
              account.loginid || null,

            account_type:
              account.account_type || null,

            currency:
              account.currency || "USD",

            status:
              account.status || "active"
          }))
      });
    }

    /* =========================
       POST
       ========================= */

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed."
        },
        405
      );
    }

    let body;

    try {
      body = await request.json();
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

    /* =========================
       MARKET
       ========================= */

    const market = String(
      body.market ||
      body.symbol ||
      body.underlying_symbol ||
      ""
    ).trim();

    if (!market) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Market is required. Select a Volatility market first."
        },
        400
      );
    }

    if (!VALID_MARKETS.includes(market)) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            `Invalid market "${market}".`,
          received_market:
            market,
          valid_markets:
            VALID_MARKETS
        },
        400
      );
    }

    /* =========================
       ACCOUNT
       ========================= */

    const accountData =
      await getAccounts();

    const accounts =
      extractAccounts(accountData);

    const account =
      findDemoAccount(accounts);

    if (!account) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "No demo Deriv Options account was found.",
          accounts:
            accounts.map(a => ({
              account_id:
                getAccountId(a),
              loginid:
                a.loginid || null,
              account_type:
                a.account_type || null,
              currency:
                a.currency || "USD"
            }))
        },
        404
      );
    }

    const accountId =
      getAccountId(account);

    const currency =
      account.currency || "USD";

    /* =========================
       PROPOSAL
       ========================= */

    if (
      body.action ===
      "proposal"
    ) {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        )
        .trim()
        .toUpperCase();

      const allowedContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF",
        "DIGITEVEN",
        "DIGITODD"
      ];

      if (
        !allowedContracts.includes(
          contractType
        )
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              `Unsupported contract type "${contractType}".`,
            allowed_contracts:
              allowedContracts
          },
          400
        );
      }

      const stake =
        Number(body.stake);

      if (
        !Number.isFinite(stake) ||
        stake <= 0
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Enter a valid stake."
          },
          400
        );
      }

      const duration =
        Number(body.duration);

      if (
        !Number.isFinite(duration) ||
        duration < 1
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Enter a valid duration."
          },
          400
        );
      }

      const durationUnit =
        String(
          body.duration_unit ||
          "t"
        );

      /*
       * DIGIT contracts require
       * a barrier except EVEN/ODD.
       */

      const digitBarrierContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ];

      let barrier = null;

      if (
        digitBarrierContracts.includes(
          contractType
        )
      ) {
        barrier = String(
          body.barrier ?? "5"
        );

        if (
          !/^[0-9]$/.test(barrier)
        ) {
          return json(
            {
              ok: false,
              connected: true,
              error:
                "Digit barrier must be a single digit from 0 to 9."
            },
            400
          );
        }
      }

      /* =========================
         AUTHENTICATED WS
         ========================= */

      const wsUrl =
        await getTradingWebSocketUrl(
          accountId
        );

      const ws =
        await openWebSocket(wsUrl);

      try {

        /*
         * IMPORTANT:
         * Use exactly the current
         * Deriv proposal structure.
         */

        const proposalRequest = {
          proposal: 1,

          amount: stake,

          basis: "stake",

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
            Date.now()
        };

        if (
          barrier !== null
        ) {
          proposalRequest.barrier =
            barrier;
        }

        const result =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal"
          );

        if (
          !result.proposal ||
          !result.proposal.id
        ) {
          return json(
            {
              ok: false,
              connected: true,
              error:
                "Deriv returned a proposal response without a proposal ID.",
              deriv_response:
                result
            },
            502
          );
        }

        return json({
          ok: true,
          connected: true,

          market:
            market,

          contract_type:
            contractType,

          account: {
            account_id:
              accountId,

            account_type:
              "demo",

            currency:
              currency
          },

          proposal: {
            id:
              result.proposal.id,

            ask_price:
              result.proposal.ask_price ??
              null,

            payout:
              result.proposal.payout ??
              null,

            spot:
              result.proposal.spot ??
              null
          },

          message:
            "Fresh proposal received."
        });

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    /* =========================
       BUY
       ========================= */

    if (
      body.action ===
      "buy"
    ) {

      const proposalId =
        String(
          body.proposal_id ||
          ""
        ).trim();

      if (!proposalId) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Proposal ID is required."
          },
          400
        );
      }

      const price =
        Number(body.price);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Invalid proposal price."
          },
          400
        );
      }

      const wsUrl =
        await getTradingWebSocketUrl(
          accountId
        );

      const ws =
        await openWebSocket(wsUrl);

      try {

        const result =
          await wsRequest(
            ws,

            {
              buy:
                proposalId,

              price:
                price,

              req_id:
                Date.now()
            },

            "buy"
          );

        if (
          !result.buy
        ) {
          return json(
            {
              ok: false,
              connected: true,
              error:
                "Deriv did not return a buy result.",
              deriv_response:
                result
            },
            502
          );
        }

        return json({
          ok: true,
          connected: true,
          purchased: true,

          account: {
            account_id:
              accountId,

            account_type:
              "demo",

            currency:
              currency
          },

          contract: {
            contract_id:
              result.buy.contract_id ??
              null,

            buy_price:
              result.buy.buy_price ??
              null,

            payout:
              result.buy.payout ??
              null,

            balance_after:
              result.buy.balance_after ??
              null,

            transaction_id:
              result.buy.transaction_id ??
              null,

            purchase_time:
              result.buy.purchase_time ??
              null
          },

          message:
            "DEMO contract purchased successfully."
        });

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    /* =========================
       UNKNOWN ACTION
       ========================= */

    return json(
      {
        ok: false,
        connected: true,
        error:
          "Unknown trading action."
      },
      400
    );

  } catch (error) {

    console.error(
      "DollarTicks trading error:",
      error
    );

    return json(
      {
        ok: false,
        connected: true,
        error:
          error.message ||
          "Unable to communicate with Deriv.",

        debug:
          error?.stack || null
      },
      500
    );
  }
          }
