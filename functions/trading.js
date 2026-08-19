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
  const PUBLIC_WS =
    "wss://api.derivws.com/trading/v1/options/ws/public";

  const VALID_MARKETS = [
    "1HZ100V",
    "1HZ75V",
    "1HZ50V",
    "1HZ25V",
    "1HZ10V"
  ];

  /*
   * GET ACCESS TOKEN FROM COOKIE
   */
  const cookies = request.headers.get("Cookie") || "";

  function getCookie(name) {
    const match = cookies.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]*)")
    );

    return match
      ? decodeURIComponent(match[2])
      : null;
  }

  const accessToken =
    getCookie("dt_access_token");

  /*
   * RESPONSE FROM DERIV REST API
   */
  async function readResponse(response) {
    const text = await response.text();

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {
        raw_response: text
      };
    }
  }

  /*
   * GET DERIV OPTIONS ACCOUNTS
   */
  async function getAccounts() {
    if (!accessToken) {
      throw new Error(
        "No Deriv login session found. Connect Deriv again."
      );
    }

    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }
    );

    const data =
      await readResponse(response);

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        data.message ||
        "Deriv rejected the account request."
      );
    }

    return data;
  }

  /*
   * EXTRACT ACCOUNTS SAFELY
   */
  function extractAccounts(data) {
    const results = [];
    const seen = new Set();

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        value.forEach(scan);
        return;
      }

      if (typeof value !== "object") {
        return;
      }

      const id =
        value.account_id ||
        value.loginid ||
        value.id;

      if (id) {
        const key = String(id);

        if (!seen.has(key)) {
          seen.add(key);
          results.push(value);
        }
      }

      Object.values(value).forEach(child => {
        if (
          child &&
          typeof child === "object"
        ) {
          scan(child);
        }
      });
    }

    scan(data);

    return results;
  }

  function accountId(account) {
    return (
      account?.account_id ||
      account?.loginid ||
      account?.id ||
      null
    );
  }

  /*
   * FIND DEMO ACCOUNT
   */
  function findDemoAccount(accounts) {
    return accounts.find(account => {
      const type =
        String(
          account.account_type || ""
        ).toLowerCase();

      const loginid =
        String(
          account.loginid || ""
        ).toUpperCase();

      return (
        type === "demo" ||
        loginid.startsWith("VRT")
      );
    }) || null;
  }

  /*
   * CREATE AUTHENTICATED WEBSOCKET
   */
  async function createAuthenticatedWebSocket(
    account
  ) {
    if (!accessToken) {
      throw new Error(
        "No Deriv login session found."
      );
    }

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
          Authorization:
            `Bearer ${accessToken}`,
          "Content-Type":
            "application/json"
        }
      }
    );

    const data =
      await readResponse(response);

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        data.message ||
        "Could not create Deriv WebSocket OTP."
      );
    }

    const url =
      data.data?.url ||
      data.url ||
      null;

    if (!url) {
      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    return new WebSocket(url);
  }

  /*
   * WAIT FOR WEBSOCKET TO OPEN
   */
  function waitForOpen(
    ws,
    timeoutMs = 15000
  ) {
    return new Promise(
      (resolve, reject) => {
        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {
          resolve();
          return;
        }

        let finished = false;

        const timeout =
          setTimeout(() => {
            if (finished) return;

            finished = true;

            reject(
              new Error(
                "Deriv WebSocket connection timed out."
              )
            );
          }, timeoutMs);

        ws.addEventListener(
          "open",
          () => {
            if (finished) return;

            finished = true;
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );

        ws.addEventListener(
          "error",
          () => {
            if (finished) return;

            finished = true;
            clearTimeout(timeout);

            reject(
              new Error(
                "Authenticated Deriv WebSocket connection failed."
              )
            );
          },
          { once: true }
        );

        ws.addEventListener(
          "close",
          event => {
            if (finished) return;

            finished = true;
            clearTimeout(timeout);

            reject(
              new Error(
                `Deriv WebSocket closed before connecting. Code: ${event.code}`
              )
            );
          },
          { once: true }
        );
      }
    );
  }

  /*
   * SEND ONE WEBSOCKET REQUEST
   * AND WAIT FOR req_id
   */
  function wsRequest(
    ws,
    payload,
    timeoutMs = 15000
  ) {
    return new Promise(
      (resolve, reject) => {
        const reqId =
          payload.req_id;

        let finished = false;

        const finish = (
          callback,
          value
        ) => {
          if (finished) return;

          finished = true;
          clearTimeout(timeout);
          callback(value);
        };

        const timeout =
          setTimeout(() => {
            finish(
              reject,
              new Error(
                "Deriv request timed out."
              )
            );
          }, timeoutMs);

        const onMessage = event => {
          try {
            const data =
              JSON.parse(event.data);

            /*
             * Ignore messages belonging
             * to another request.
             */
            if (
              data.req_id !== undefined &&
              reqId !== undefined &&
              data.req_id !== reqId
            ) {
              return;
            }

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

            finish(resolve, data);

          } catch (error) {
            finish(reject, error);
          }
        };

        const onError = () => {
          finish(
            reject,
            new Error(
              "Deriv WebSocket request failed."
            )
          );
        };

        ws.addEventListener(
          "message",
          onMessage
        );

        ws.addEventListener(
          "error",
          onError,
          { once: true }
        );

        try {
          ws.send(
            JSON.stringify(payload)
          );
        } catch (error) {
          finish(reject, error);
        }
      }
    );
  }

  /*
   * CHECK WHICH CONTRACTS ARE AVAILABLE
   * FOR THE SELECTED MARKET.
   *
   * THIS USES THE PUBLIC WEBSOCKET.
   */
  async function getAvailableContracts(
    market
  ) {
    const ws =
      new WebSocket(PUBLIC_WS);

    try {
      await waitForOpen(ws);

      const reqId = Date.now();

      const result =
        await wsRequest(
          ws,
          {
            contracts_for: market,
            req_id: reqId
          }
        );

      const available =
        result.contracts_for?.available ||
        [];

      return available;

    } finally {
      try {
        ws.close();
      } catch {}
    }
  }

  /*
   * NORMALISE THE CONTRACT TYPE.
   */
  function normaliseContractType(
    value
  ) {
    const type =
      String(value || "")
      .trim()
      .toUpperCase();

    const aliases = {
      OVER: "DIGITOVER",
      UNDER: "DIGITUNDER",
      MATCH: "DIGITMATCH",
      MATCHES: "DIGITMATCH",
      DIFFER: "DIGITDIFF",
      DIFFERS: "DIGITDIFF",
      EVEN: "DIGITEVEN",
      ODD: "DIGITODD"
    };

    return aliases[type] || type;
  }

  /*
   * CHECK IF CONTRACT IS AVAILABLE.
   */
  function contractIsAvailable(
    available,
    contractType
  ) {
    return available.some(contract =>
      String(
        contract.contract_type || ""
      ).toUpperCase() ===
      contractType
    );
  }

  /*
   * CHECK MARKET
   */
  function validateMarket(body) {
    const market =
      String(
        body.market ||
        body.symbol ||
        body.underlying_symbol ||
        ""
      ).trim();

    if (!market) {
      throw new Error(
        "Market is required. Select a Volatility market first."
      );
    }

    if (
      !VALID_MARKETS.includes(market)
    ) {
      throw new Error(
        `Invalid market: ${market}`
      );
    }

    return market;
  }

  /*
   * MAIN
   */
  try {

    /*
     * GET ACCOUNT STATUS
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
        connected: Boolean(demo),

        selected_account: demo
          ? {
              account_id:
                accountId(demo),
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
              accountId(account),
            loginid:
              account.loginid || null,
            account_type:
              account.account_type ||
              null,
            currency:
              account.currency ||
              "USD",
            status:
              account.status ||
              "active"
          })),

        message: demo
          ? "Deriv demo account found."
          : "No demo account found."
      });
    }

    if (
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

    const body =
      await request.json();

    const action =
      String(
        body.action || ""
      ).toLowerCase();

    /*
     * VALIDATE ACTION
     */
    if (
      action !== "proposal" &&
      action !== "buy"
    ) {
      return json(
        {
          ok: false,
          error:
            "Unknown trading action."
        },
        400
      );
    }

    /*
     * GET DEMO ACCOUNT
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

    const account_id =
      accountId(account);

    /*
     * PROPOSAL
     */
    if (action === "proposal") {

      const market =
        validateMarket(body);

      const contractType =
        normaliseContractType(
          body.contract_type
        );

      const allowedDigitContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF",
        "DIGITEVEN",
        "DIGITODD"
      ];

      if (
        !allowedDigitContracts.includes(
          contractType
        )
      ) {
        return json(
          {
            ok: false,
            error:
              `Unsupported contract type: ${contractType}`
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
            error:
              "Enter a valid stake greater than 0."
          },
          400
        );
      }

      const duration =
        Number(body.duration || 1);

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
       * CHECK CONTRACT AVAILABILITY FIRST.
       */
      const available =
        await getAvailableContracts(
          market
        );

      const availableTypes =
        available.map(contract =>
          String(
            contract.contract_type ||
            ""
          ).toUpperCase()
        );

      if (
        !contractIsAvailable(
          available,
          contractType
        )
      ) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              `${contractType} is not available for ${market}.`,
            market: market,
            requested_contract:
              contractType,
            available_contract_types:
              availableTypes
          },
          400
        );
      }

      /*
       * BUILD PROPOSAL
       */
      const proposalRequest = {
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type:
          contractType,
        currency:
          account.currency || "USD",
        duration: duration,
        duration_unit:
          body.duration_unit || "t",
        underlying_symbol:
          market,
        req_id: Date.now()
      };

      /*
       * ONLY THESE FOUR NEED A BARRIER.
       */
      const barrierContracts = [
        "DIGITOVER",
        "DIGITUNDER",
        "DIGITMATCH",
        "DIGITDIFF"
      ];

      if (
        barrierContracts.includes(
          contractType
        )
      ) {
        const barrier =
          Number(
            body.barrier ?? 5
          );

        if (
          !Number.isInteger(barrier) ||
          barrier < 0 ||
          barrier > 9
        ) {
          return json(
            {
              ok: false,
              error:
                "Barrier must be a digit from 0 to 9."
            },
            400
          );
        }

        proposalRequest.barrier =
          String(barrier);
      }

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {
        await waitForOpen(ws);

        const result =
          await wsRequest(
            ws,
            proposalRequest
          );

        if (
          result.msg_type !== "proposal" ||
          !result.proposal?.id
        ) {
          throw new Error(
            "Deriv returned an invalid contract proposal."
          );
        }

        return json({
          ok: true,
          connected: true,

          account: {
            account_id:
              account_id,
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
            "Fresh proposal received successfully."
        });

      } finally {
        try {
          ws.close();
        } catch {}
      }
    }

    /*
     * BUY
     */
    if (action === "buy") {

      if (!body.proposal_id) {
        return json(
          {
            ok: false,
            error:
              "Get a fresh proposal before buying."
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
        await waitForOpen(ws);

        const result =
          await wsRequest(
            ws,
            {
              buy:
                String(
                  body.proposal_id
                ),

              price:
                price,

              req_id:
                Date.now()
            }
          );

        if (
          result.msg_type !== "buy" ||
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
              account_id,
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

  } catch (error) {

    console.error(
      "DollarTicks trading error:",
      error
    );

    return json(
      {
        ok: false,

        connected:
          Boolean(accessToken),

        error:
          error.message ||
          "Unable to communicate with Deriv."
      },
      500
    );
  }
  }
