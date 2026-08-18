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

  const cookies = request.headers.get("Cookie") || "";

  function getCookie(name) {
    const match = cookies.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]*)")
    );

    return match ? decodeURIComponent(match[2]) : null;
  }

  const accessToken = getCookie("dt_access_token");

  if (!accessToken) {
    return json(
      {
        ok: false,
        connected: false,
        error: "Deriv login session missing. Connect Deriv again."
      },
      401
    );
  }

  const APP_ID = "347btQbpUS2La9uhcLb2X";
  const API = "https://api.derivws.com";

  /*
   * --------------------------------------------------
   * GET OPTIONS ACCOUNTS
   * --------------------------------------------------
   */

  async function getAccounts() {
    const response = await fetch(
      `${API}/trading/v1/options/accounts`,
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
        data?.errors?.[0]?.message ||
        data?.error?.message ||
        `Deriv accounts request failed (${response.status}).`
      );
    }

    return data;
  }

  /*
   * --------------------------------------------------
   * NORMALIZE ACCOUNT RESPONSE
   *
   * Deriv can return:
   *
   * data: {...}
   *
   * or
   *
   * data: [{...}]
   *
   * --------------------------------------------------
   */

  function normalizeAccounts(response) {
    const output = [];

    function add(value) {
      if (!value || typeof value !== "object") return;

      const id =
        value.account_id ||
        value.loginid ||
        value.id;

      if (!id) return;

      output.push({
        ...value,
        account_id: String(id)
      });
    }

    if (Array.isArray(response?.data)) {
      response.data.forEach(add);
    } else {
      add(response?.data);
    }

    /*
     * Also support nested account containers.
     */
    const containers = [
      response?.accounts,
      response?.data?.accounts,
      response?.data?.data
    ];

    for (const container of containers) {
      if (Array.isArray(container)) {
        container.forEach(add);
      } else {
        add(container);
      }
    }

    const unique = [];
    const seen = new Set();

    for (const account of output) {
      if (!seen.has(account.account_id)) {
        seen.add(account.account_id);
        unique.push(account);
      }
    }

    return unique;
  }

  /*
   * --------------------------------------------------
   * FIND DEMO ACCOUNT
   * --------------------------------------------------
   */

  function findDemoAccount(accounts) {
    if (!Array.isArray(accounts)) return null;

    /*
     * First look for explicit demo account.
     */
    let account = accounts.find(a => {
      const type = String(
        a.account_type || ""
      ).toLowerCase();

      return type === "demo";
    });

    if (account) return account;

    /*
     * Then check login ID conventions.
     */
    account = accounts.find(a => {
      const loginid = String(
        a.loginid || ""
      ).toLowerCase();

      return (
        loginid.startsWith("vrt") ||
        loginid.startsWith("vrt_")
      );
    });

    if (account) return account;

    /*
     * IMPORTANT:
     * Deriv Options accounts returned by this endpoint
     * are already Options accounts. If there is exactly
     * one account and its type wasn't supplied, use it
     * rather than incorrectly reporting "account not found".
     */
    if (accounts.length === 1) {
      return accounts[0];
    }

    return null;
  }

  /*
   * --------------------------------------------------
   * GET ACCOUNT ID
   * --------------------------------------------------
   */

  function getAccountId(account) {
    return (
      account?.account_id ||
      account?.loginid ||
      account?.id ||
      null
    );
  }

  /*
   * --------------------------------------------------
   * CREATE AUTHENTICATED WEBSOCKET
   *
   * Deriv returns a ready-to-use WebSocket URL.
   * We MUST connect directly to that URL.
   * --------------------------------------------------
   */

  async function createAuthenticatedWebSocket(account) {
    const accountId = getAccountId(account);

    if (!accountId) {
      throw new Error(
        "Deriv returned an account without an account ID."
      );
    }

    const response = await fetch(
      `${API}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
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
        data?.errors?.[0]?.message ||
        data?.error?.message ||
        `Could not create Deriv trading connection (${response.status}).`
      );
    }

    const wsUrl = data?.data?.url;

    if (!wsUrl) {
      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    return new WebSocket(wsUrl);
  }

  /*
   * --------------------------------------------------
   * WEBSOCKET REQUEST
   * --------------------------------------------------
   */

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeout = 15000
  ) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const timer = setTimeout(() => {
        if (finished) return;

        finished = true;

        reject(
          new Error(
            "Deriv trading request timed out."
          )
        );
      }, timeout);

      function finish(fn, value) {
        if (finished) return;

        finished = true;
        clearTimeout(timer);

        fn(value);
      }

      ws.addEventListener("message", event => {
        try {
          const data =
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : event.data;

          if (data?.error) {
            finish(
              reject,
              new Error(
                data.error.message ||
                "Deriv rejected the trading request."
              )
            );
            return;
          }

          if (
            data?.msg_type === expectedMessage
          ) {
            finish(resolve, data);
          }

        } catch (error) {
          finish(reject, error);
        }
      });

      ws.addEventListener("error", () => {
        finish(
          reject,
          new Error(
            "Authenticated Deriv WebSocket connection failed."
          )
        );
      });

      ws.addEventListener("close", event => {
        if (!finished) {
          finish(
            reject,
            new Error(
              `Deriv WebSocket closed before receiving ${expectedMessage} response.`
            )
          );
        }
      });

      const send = () => {
        try {
          ws.send(
            JSON.stringify(payload)
          );
        } catch (error) {
          finish(reject, error);
        }
      };

      if (
        ws.readyState === WebSocket.OPEN
      ) {
        send();
      } else {
        ws.addEventListener(
          "open",
          send,
          { once: true }
        );
      }
    });
  }

  try {

    /*
     * ==================================================
     * GET /trading
     * ==================================================
     */

    if (request.method === "GET") {

      const accountResponse =
        await getAccounts();

      const accounts =
        normalizeAccounts(accountResponse);

      if (!accounts.length) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Deriv is connected, but no Options account was returned.",
            deriv_response:
              accountResponse
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
                  String(
                    demo.account_type ||
                    "demo"
                  ).toLowerCase(),

                currency:
                  demo.currency ||
                  "USD",

                status:
                  demo.status ||
                  "active",

                balance:
                  demo.balance ??
                  null
              }
            : null,

        accounts:
          accounts.map(account => ({
            account_id:
              getAccountId(account),

            loginid:
              account.loginid ||
              null,

            account_type:
              account.account_type ||
              null,

            currency:
              account.currency ||
              "USD",

            status:
              account.status ||
              "active",

            balance:
              account.balance ??
              null
          })),

        message:
          demo
            ? "Deriv demo Options account found."
            : "Options account returned, but no demo account was identified."
      });
    }

    /*
     * ==================================================
     * POST ONLY
     * ==================================================
     */

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed."
        },
        405
      );
    }

    const body =
      await request.json();

    /*
     * ==================================================
     * MARKET
     * ==================================================
     */

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

    const validMarkets = [
      "1HZ100V",
      "1HZ75V",
      "1HZ50V",
      "1HZ25V",
      "1HZ10V"
    ];

    if (!validMarkets.includes(market)) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            `Invalid market "${market}". Select a Volatility market first.`,
          received_market:
            market,
          valid_markets:
            validMarkets
        },
        400
      );
    }

    /*
     * ==================================================
     * GET OPTIONS ACCOUNTS
     * ==================================================
     */

    const accountResponse =
      await getAccounts();

    const accounts =
      normalizeAccounts(accountResponse);

    if (!accounts.length) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Deriv is connected, but no Options account was returned.",
          deriv_response:
            accountResponse
        },
        404
      );
    }

    const account =
      findDemoAccount(accounts);

    if (!account) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "No demo Options account was found.",
          accounts:
            accounts.map(a => ({
              account_id:
                getAccountId(a),
              loginid:
                a.loginid || null,
              account_type:
                a.account_type || null,
              currency:
                a.currency || "USD",
              status:
                a.status || null
            }))
        },
        404
      );
    }

    const accountId =
      getAccountId(account);

    if (!accountId) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Options account was returned without an account ID."
        },
        400
      );
    }

    /*
     * ==================================================
     * ACCOUNT ACTION
     * ==================================================
     */

    if (body.action === "account") {

      return json({
        ok: true,
        connected: true,

        account: {
          account_id:
            accountId,

          loginid:
            account.loginid ||
            null,

          account_type:
            account.account_type ||
            "demo",

          currency:
            account.currency ||
            "USD",

          status:
            account.status ||
            "active",

          balance:
            account.balance ??
            null
        }
      });
    }

    /*
     * ==================================================
     * PROPOSAL
     * ==================================================
     */

    if (body.action === "proposal") {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        ).toUpperCase();

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
              `Unsupported digit contract: ${contractType}.`
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
              "Enter a valid stake greater than 0."
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
              "Enter a valid duration of at least 1 tick."
          },
          400
        );
      }

      /*
       * Create a brand-new authenticated connection.
       */

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {

        const proposalRequest = {
          proposal: 1,

          amount:
            stake,

          basis:
            "stake",

          contract_type:
            contractType,

          currency:
            account.currency ||
            "USD",

          duration:
            duration,

          duration_unit:
            body.duration_unit ||
            "t",

          underlying_symbol:
            market,

          req_id:
            Date.now()
        };

        /*
         * Only these digit contracts require
         * a barrier.
         */
        if (
          [
            "DIGITOVER",
            "DIGITUNDER",
            "DIGITMATCH",
            "DIGITDIFF"
          ].includes(
            contractType
          )
        ) {
          const barrier =
            Number(body.barrier);

          if (
            !Number.isInteger(barrier) ||
            barrier < 0 ||
            barrier > 9
          ) {
            throw new Error(
              "Barrier must be a digit from 0 to 9."
            );
          }

          proposalRequest.barrier =
            String(barrier);
        }

        const result =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal"
          );

        if (
          !result?.proposal?.id
        ) {
          throw new Error(
            "Deriv returned an unknown contract proposal."
          );
        }

        return json({
          ok: true,
          connected: true,

          account: {
            account_id:
              accountId,

            account_type:
              "demo",

            currency:
              account.currency ||
              "USD"
          },

          market:
            market,

          contract_type:
            contractType,

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
            "Fresh Deriv proposal received."
        });

      } finally {

        try {
          ws.close();
        } catch {}
      }
    }

    /*
     * ==================================================
     * BUY
     * ==================================================
     */

    if (body.action === "buy") {

      if (!body.proposal_id) {
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

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {

        const buyRequest = {
          buy:
            String(body.proposal_id),

          price:
            price,

          req_id:
            Date.now()
        };

        const result =
          await wsRequest(
            ws,
            buyRequest,
            "buy"
          );

        if (!result?.buy) {
          throw new Error(
            "Deriv did not return a purchase result."
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
              account.currency ||
              "USD"
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
              null,

            start_time:
              result.buy.start_time ??
              null,

            longcode:
              result.buy.longcode ??
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

    /*
     * ==================================================
     * UNKNOWN ACTION
     * ==================================================
     */

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
          error?.message ||
          "Unable to communicate with Deriv."
      },
      500
    );
  }
          }
