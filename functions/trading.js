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

  const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
  const DERIV_API = "https://api.derivws.com";

  /*
   * =====================================================
   * GET OPTIONS ACCOUNTS
   * =====================================================
   */

  async function getAccounts() {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",

        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": CLIENT_ID,
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

  /*
   * =====================================================
   * EXTRACT ACCOUNTS
   * =====================================================
   */

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

      if (!id) {
        return false;
      }

      const key = String(id);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
  }

  function getAccountId(account) {
    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }

  /*
   * =====================================================
   * FIND DEMO ACCOUNT
   * =====================================================
   */

  function findDemoAccount(accounts) {
    return accounts.find(account => {
      const type = String(
        account.account_type || ""
      ).toLowerCase();

      const loginid = String(
        account.loginid || ""
      ).toLowerCase();

      return (
        type === "demo" ||
        loginid.startsWith("vrt")
      );
    });
  }

  /*
   * =====================================================
   * CREATE AUTHENTICATED DERIV WEBSOCKET
   * =====================================================
   */

  async function createAuthenticatedWebSocket(account) {
    const accountId = getAccountId(account);

    if (!accountId) {
      throw new Error(
        "Deriv account ID was not returned."
      );
    }

    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(
        accountId
      )}/otp`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": CLIENT_ID,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Deriv rejected the trading connection."
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

    const ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "Authenticated Deriv WebSocket connection timed out."
          )
        );
      }, 15000);

      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );

      ws.addEventListener(
        "error",
        () => {
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

    return ws;
  }

  /*
   * =====================================================
   * SEND WEBSOCKET REQUEST
   * =====================================================
   */

  function sendWebSocketRequest(
    ws,
    payload,
    expectedType
  ) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;

        finished = true;

        reject(
          new Error(
            "Deriv WebSocket request timed out."
          )
        );
      }, 15000);

      function finish(fn, value) {
        if (finished) return;

        finished = true;

        clearTimeout(timeout);

        fn(value);
      }

      const onMessage = event => {
        try {
          const data =
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : event.data;

          if (data.error) {
            finish(
              reject,
              new Error(
                data.error.message ||
                "Deriv rejected the request."
              )
            );

            return;
          }

          if (
            data.msg_type === expectedType
          ) {
            ws.removeEventListener(
              "message",
              onMessage
            );

            finish(resolve, data);
          }
        } catch (error) {
          finish(reject, error);
        }
      };

      ws.addEventListener(
        "message",
        onMessage
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

  /*
   * =====================================================
   * VALID MARKETS
   * =====================================================
   */

  const VALID_MARKETS = [
    "1HZ10V",
    "1HZ25V",
    "1HZ50V",
    "1HZ75V",
    "1HZ100V"
  ];

  /*
   * =====================================================
   * VALID CONTRACTS
   * =====================================================
   */

  const VALID_CONTRACTS = [
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITDIFF",
    "DIGITEVEN",
    "DIGITODD"
  ];

  try {

    /*
     * ===================================================
     * GET
     * ===================================================
     */

    if (request.method === "GET") {

      const accountData =
        await getAccounts();

      const accounts =
        extractAccounts(accountData);

      const demo =
        findDemoAccount(accounts);

      return json({
        ok: true,

        connected: true,

        selected_account: demo
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

    /*
     * ===================================================
     * POST ONLY
     * ===================================================
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
     * ===================================================
     * MARKET
     *
     * Accept all common names from the frontend.
     * ===================================================
     */

    const market = String(
      body.market ||
      body.symbol ||
      body.underlying_symbol ||
      body.underlying ||
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

    if (
      !VALID_MARKETS.includes(market)
    ) {
      return json(
        {
          ok: false,
          connected: true,

          error:
            `Invalid market "${market}".`,

          valid_markets:
            VALID_MARKETS
        },
        400
      );
    }

    /*
     * ===================================================
     * ACCOUNT
     * ===================================================
     */

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
            "No demo Deriv Options account was found."
        },
        404
      );
    }

    const accountId =
      getAccountId(account);

    /*
     * ===================================================
     * PROPOSAL
     * ===================================================
     */

    if (
      body.action === "proposal"
    ) {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        ).trim().toUpperCase();

      if (
        !VALID_CONTRACTS.includes(
          contractType
        )
      ) {
        return json(
          {
            ok: false,
            connected: true,

            error:
              `Invalid contract type "${contractType}".`,

            valid_contracts:
              VALID_CONTRACTS
          },
          400
        );
      }

      const stake =
        Number(body.stake);

      const duration =
        Number(body.duration);

      if (
        !Number.isFinite(stake) ||
        stake <= 0
      ) {
        return json(
          {
            ok: false,
            error:
              "Enter a valid stake."
          },
          400
        );
      }

      if (
        !Number.isFinite(duration) ||
        duration < 1
      ) {
        return json(
          {
            ok: false,
            error:
              "Enter a valid duration."
          },
          400
        );
      }

      /*
       * DIGIT contracts require a barrier.
       */

      const digitContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ];

      let barrier = null;

      if (
        digitContracts.includes(
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
              error:
                "Barrier must be a single digit from 0 to 9."
            },
            400
          );
        }
      }

      /*
       * Create authenticated connection.
       */

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {

        /*
         * IMPORTANT:
         *
         * This is the actual proposal request.
         */

        const proposalRequest = {
          proposal: 1,

          amount: stake,

          basis: "stake",

          contract_type:
            contractType,

          currency:
            account.currency || "USD",

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
          barrier !== null
        ) {
          proposalRequest.barrier =
            barrier;
        }

        console.log(
          "DollarTicks proposal request:",
          JSON.stringify(
            proposalRequest
          )
        );

        const result =
          await sendWebSocketRequest(
            ws,
            proposalRequest,
            "proposal"
          );

        const proposal =
          result.proposal;

        if (
          !proposal ||
          !proposal.id
        ) {
          throw new Error(
            "Deriv returned an unknown contract proposal."
          );
        }

        return json({
          ok: true,

          connected: true,

          market: market,

          account: {
            account_id:
              accountId,

            account_type:
              "demo",

            currency:
              account.currency ||
              "USD"
          },

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
     * ===================================================
     * BUY
     * ===================================================
     */

    if (
      body.action === "buy"
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
            proposalId,

          price:
            price,

          req_id:
            Date.now()
        };

        const result =
          await sendWebSocketRequest(
            ws,
            buyRequest,
            "buy"
          );

        if (
          !result.buy
        ) {
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
     * ===================================================
     * UNKNOWN ACTION
     * ===================================================
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
          error.message ||
          "Unable to communicate with Deriv."
      },
      500
    );
  }
  }
