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

      if (typeof value !== "object") return;

      if (
        value.account_id ||
        value.loginid ||
        (
          value.id &&
          (
            value.account_type ||
            value.currency ||
            value.status
          )
        )
      ) {
        found.push(value);
      }

      for (const key of Object.keys(value)) {
        const child = value[key];

        if (
          child &&
          typeof child === "object"
        ) {
          scan(child);
        }
      }
    }

    scan(data);

    const unique = [];
    const seen = new Set();

    for (const account of found) {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) continue;

      const key = String(id);

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(account);
      }
    }

    return unique;
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
    return (
      accounts.find(account =>
        String(
          account.account_type || ""
        ).toLowerCase() === "demo"
      ) ||
      accounts.find(account =>
        String(
          account.loginid || ""
        ).toUpperCase()
        .startsWith("VRT")
      ) ||
      accounts.find(account =>
        String(
          account.account_id || ""
        ).toUpperCase()
        .startsWith("DOT")
      ) ||
      null
    );
  }

  /*
   * =====================================================
   * GET DEMO ACCOUNT
   * =====================================================
   */

  async function getDemoAccount() {
    const data = await getAccounts();

    const accounts = extractAccounts(data);

    if (!accounts.length) {
      throw new Error(
        "No Deriv Options account was returned."
      );
    }

    const demo = findDemoAccount(accounts);

    if (!demo) {
      throw new Error(
        "Deriv is connected, but no demo Options account was found."
      );
    }

    return {
      account: demo,
      accounts
    };
  }

  /*
   * =====================================================
   * GET AUTHENTICATED WEBSOCKET URL
   *
   * IMPORTANT:
   * Deriv returns the complete URL.
   *
   * Example:
   *
   * wss://api.derivws.com/trading/v1/options/ws/demo?otp=xxxxx
   *
   * We use that URL exactly as returned.
   * =====================================================
   */

  async function getAuthenticatedWebSocketUrl(accountId) {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(
        accountId
      )}/otp`,
      {
        method: "POST",
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
        `Deriv OTP request failed (${response.status}).`
      );
    }

    const url = data.data?.url;

    if (!url) {
      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    return url;
  }

  /*
   * =====================================================
   * OPEN AUTHENTICATED WEBSOCKET
   * =====================================================
   */

  async function openAuthenticatedWebSocket(accountId) {
    /*
     * Request a fresh OTP immediately before connecting.
     */
    const wsUrl =
      await getAuthenticatedWebSocketUrl(
        accountId
      );

    /*
     * IMPORTANT:
     * Do not modify wsUrl.
     * The OTP is already inside the URL.
     */
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;

        finished = true;

        try {
          ws.close();
        } catch {}

        reject(
          new Error(
            "Authenticated Deriv WebSocket connection timed out."
          )
        );
      }, 15000);

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
        () => {
          if (finished) return;

          finished = true;
          clearTimeout(timeout);

          reject(
            new Error(
              "Deriv closed the authenticated WebSocket before it connected."
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

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeoutMs = 15000
  ) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const finish = (fn, value) => {
        if (finished) return;

        finished = true;

        clearTimeout(timeout);

        try {
          ws.removeEventListener(
            "message",
            onMessage
          );
        } catch {}

        fn(value);
      };

      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(
            `Deriv ${expectedMessage} request timed out.`
          )
        );
      }, timeoutMs);

      const onMessage = event => {
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
      };

      ws.addEventListener(
        "message",
        onMessage
      );

      try {
        if (
          ws.readyState !==
          WebSocket.OPEN
        ) {
          finish(
            reject,
            new Error(
              "Authenticated WebSocket is not open."
            )
          );

          return;
        }

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
   * FORMAT ACCOUNT
   * =====================================================
   */

  function formatAccount(account) {
    return {
      account_id:
        getAccountId(account),

      loginid:
        account.loginid || null,

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
    };
  }

  try {

    /*
     * =====================================================
     * GET /trading
     * =====================================================
     */

    if (
      request.method === "GET"
    ) {

      const result =
        await getDemoAccount();

      return json({
        ok: true,

        connected: true,

        selected_account:
          formatAccount(
            result.account
          ),

        accounts:
          result.accounts.map(
            formatAccount
          ),

        message:
          "Deriv demo Options account is connected."
      });
    }

    /*
     * =====================================================
     * ONLY POST BELOW
     * =====================================================
     */

    if (
      request.method !== "POST"
    ) {
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
     * =====================================================
     * DEMO ONLY
     * =====================================================
     */

    const result =
      await getDemoAccount();

    const account =
      result.account;

    const accountId =
      getAccountId(account);

    if (!accountId) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Demo account was found, but no account ID was returned."
        },
        400
      );
    }

    /*
     * =====================================================
     * ACCOUNT
     * =====================================================
     */

    if (
      body.action === "account"
    ) {
      return json({
        ok: true,

        connected: true,

        account:
          formatAccount(account)
      });
    }

    /*
     * =====================================================
     * PROPOSAL
     * =====================================================
     */

    if (
      body.action === "proposal"
    ) {

      const contractType =
        String(
          body.contract_type || ""
        ).toUpperCase();

      if (!contractType) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Contract type is required."
          },
          400
        );
      }

      const market =
        String(
          body.market || ""
        );

      if (!market) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Market is required."
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
              "Enter a valid demo stake."
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

      /*
       * Fresh authenticated socket.
       */
      const ws =
        await openAuthenticatedWebSocket(
          accountId
        );

      try {

        const proposalRequest = {
          proposal: 1,

          amount: stake,

          basis: "stake",

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

        const digitContracts = [
          "DIGITOVER",
          "DIGITUNDER",
          "DIGITMATCH",
          "DIGITDIFF",
          "DIGITEVEN",
          "DIGITODD"
        ];

        if (
          digitContracts.includes(
            contractType
          )
        ) {
          proposalRequest.barrier =
            String(
              body.barrier ?? 5
            );
        }

        const data =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal"
          );

        const proposal =
          data.proposal;

        if (!proposal?.id) {
          throw new Error(
            "Deriv returned a proposal without a proposal ID."
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
            "Fresh demo proposal received. Buy it immediately."
        });

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    /*
     * =====================================================
     * BUY DEMO
     * =====================================================
     */

    if (
      body.action === "buy"
    ) {

      if (!body.proposal_id) {
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

      /*
       * Fresh authenticated socket.
       */
      const ws =
        await openAuthenticatedWebSocket(
          accountId
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

        const data =
          await wsRequest(
            ws,
            buyRequest,
            "buy"
          );

        const buy =
          data.buy;

        if (!buy) {
          throw new Error(
            "Deriv did not return a purchase result."
          );
        }

        return json({
          ok: true,

          connected: true,

          purchased: true,

          real_account: false,

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
              buy.contract_id ??
              null,

            buy_price:
              buy.buy_price ??
              null,

            payout:
              buy.payout ??
              null,

            balance_after:
              buy.balance_after ??
              null,

            transaction_id:
              buy.transaction_id ??
              null,

            purchase_time:
              buy.purchase_time ??
              null,

            start_time:
              buy.start_time ??
              null,

            longcode:
              buy.longcode ??
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
     * =====================================================
     * UNKNOWN ACTION
     * =====================================================
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
