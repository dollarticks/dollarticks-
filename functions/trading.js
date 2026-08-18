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
        error: "No Deriv login session found. Connect Deriv again."
      },
      401
    );
  }

  const clientId = "347btQbpUS2La9uhcLb2X";
  const DERIV_API = "https://api.derivws.com";

  /*
   * Default market.
   * If index.html fails to send the market,
   * DollarTicks will use Volatility 100 (1s).
   */
  const DEFAULT_MARKET = "1HZ100V";

  const VALID_MARKETS = [
    "1HZ100V",
    "1HZ75V",
    "1HZ50V",
    "1HZ25V",
    "1HZ10V"
  ];

  async function getAccounts() {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": clientId,
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

  function extractAccounts(data) {
    const accounts = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
        return;
      }

      if (typeof value !== "object") return;

      if (
        value.account_id ||
        value.loginid ||
        value.id
      ) {
        accounts.push(value);
      }

      for (const key of Object.keys(value)) {
        scan(value[key]);
      }
    }

    scan(data);

    const unique = [];
    const seen = new Set();

    for (const account of accounts) {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) continue;

      const key = String(id);

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(account);
    }

    return unique;
  }

  function accountId(account) {
    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }

  function findDemo(accounts) {
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

  async function createWebSocket(account) {
    const id = accountId(account);

    if (!id) {
      throw new Error(
        "Deriv account ID is missing."
      );
    }

    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(id)}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": clientId,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.data?.url) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Could not create authenticated Deriv connection."
      );
    }

    return new WebSocket(data.data.url);
  }

  function wsRequest(
    ws,
    payload,
    expectedMessage
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
      }, 15000);

      function finish(callback, value) {
        if (finished) return;

        finished = true;
        clearTimeout(timeout);

        callback(value);
      }

      ws.addEventListener(
        "message",
        event => {
          try {
            const data =
              JSON.parse(event.data);

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
              data.msg_type ===
              expectedMessage
            ) {
              finish(resolve, data);
            }

          } catch (error) {
            finish(reject, error);
          }
        }
      );

      ws.addEventListener(
        "error",
        () => {
          finish(
            reject,
            new Error(
              "Authenticated Deriv WebSocket connection failed."
            )
          );
        }
      );

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
        ws.readyState ===
        WebSocket.OPEN
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
     * ==========================================
     * GET
     * ==========================================
     */

    if (request.method === "GET") {

      const data =
        await getAccounts();

      const accounts =
        extractAccounts(data);

      if (!accounts.length) {
        return json({
          ok: false,
          connected: true,
          error:
            "Deriv login succeeded, but no Options account was found."
        });
      }

      const demo =
        findDemo(accounts);

      return json({
        ok: true,
        connected: true,

        selected_account:
          demo
            ? {
                account_id:
                  accountId(demo),

                loginid:
                  demo.loginid ||
                  null,

                account_type:
                  "demo",

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
              accountId(account),

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
              "active"
          }))
      });
    }

    /*
     * ==========================================
     * ONLY POST BELOW THIS POINT
     * ==========================================
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

    let body = {};

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

    /*
     * ==========================================
     * MARKET
     * ==========================================
     *
     * We accept several possible names so the
     * frontend cannot accidentally break this.
     */

    let market = String(
      body.market ||
      body.symbol ||
      body.underlying_symbol ||
      ""
    ).trim();

    /*
     * If nothing was received, automatically use
     * Volatility 100 (1s).
     */

    if (!market) {
      market = DEFAULT_MARKET;
    }

    /*
     * Validate market.
     */

    if (
      !VALID_MARKETS.includes(
        market
      )
    ) {
      return json(
        {
          ok: false,
          connected: true,

          error:
            "Invalid Volatility market.",

          received_market:
            market,

          valid_markets:
            VALID_MARKETS
        },
        400
      );
    }

    /*
     * ==========================================
     * GET DEMO ACCOUNT
     * ==========================================
     */

    const accountData =
      await getAccounts();

    const accounts =
      extractAccounts(
        accountData
      );

    if (!accounts.length) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "No Deriv Options account was returned."
        },
        404
      );
    }

    const account =
      findDemo(accounts);

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
                accountId(a),

              loginid:
                a.loginid ||
                null,

              account_type:
                a.account_type ||
                null,

              currency:
                a.currency ||
                "USD"
            }))
        },
        404
      );
    }

    const id =
      accountId(account);

    /*
     * ==========================================
     * PROPOSAL
     * ==========================================
     */

    if (
      body.action ===
      "proposal"
    ) {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        ).toUpperCase();

      const stake =
        Number(
          body.stake ||
          1
        );

      const duration =
        Number(
          body.duration ||
          1
        );

      if (
        !Number.isFinite(
          stake
        ) ||
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
        !Number.isFinite(
          duration
        ) ||
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

      const ws =
        await createWebSocket(
          account
        );

      try {

        /*
         * This is the important part:
         * the selected Volatility market is
         * explicitly sent to Deriv.
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
         * Digit contracts.
         */

        const digitContracts = [
          "DIGITOVER",
          "DIGITUNDER",
          "DIGITMATCH",
          "DIGITDIFF"
        ];

        if (
          digitContracts.includes(
            contractType
          )
        ) {

          proposalRequest.barrier =
            String(
              body.barrier ??
              5
            );
        }

        console.log(
          "DollarTicks proposal:",
          JSON.stringify(
            proposalRequest
          )
        );

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
          throw new Error(
            "Deriv returned an invalid proposal."
          );
        }

        return json({
          ok: true,

          connected: true,

          market:
            market,

          account: {
            account_id:
              id,

            account_type:
              "demo",

            currency:
              account.currency ||
              "USD"
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

    /*
     * ==========================================
     * BUY DEMO CONTRACT
     * ==========================================
     */

    if (
      body.action ===
      "buy"
    ) {

      if (
        !body.proposal_id
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Get a fresh proposal before buying."
          },
          400
        );
      }

      const price =
        Number(
          body.price
        );

      if (
        !Number.isFinite(
          price
        ) ||
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
        await createWebSocket(
          account
        );

      try {

        const buyRequest = {

          buy:
            String(
              body.proposal_id
            ),

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
              id,

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
     * ==========================================
     * UNKNOWN ACTION
     * ==========================================
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
