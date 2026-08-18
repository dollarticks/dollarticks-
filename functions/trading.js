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
   * Get accounts from Deriv.
   */
  async function getAccounts() {
    const response = await fetch(
      DERIV_API + "/trading/v1/options/accounts",
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
   * Find account list regardless of the exact
   * shape returned by Deriv.
   */
  function extractAccounts(data) {
    const results = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
        return;
      }

      if (typeof value !== "object") return;

      const hasAccountId =
        value.account_id ||
        value.loginid ||
        value.id;

      if (hasAccountId) {
        results.push(value);
      }

      for (const key of Object.keys(value)) {
        if (
          value[key] &&
          typeof value[key] === "object"
        ) {
          scan(value[key]);
        }
      }
    }

    scan(data);

    const unique = [];
    const seen = new Set();

    for (const account of results) {
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

  function accountId(account) {
    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }

  /*
   * Find demo/real account.
   *
   * This also handles cases where Deriv describes
   * demo accounts using different fields.
   */
  function findAccount(accounts, requestedType, requestedId) {
    if (requestedId) {
      const exact = accounts.find(
        account =>
          String(accountId(account)) ===
          String(requestedId)
      );

      if (exact) return exact;
    }

    const type = String(
      requestedType || "demo"
    ).toLowerCase();

    if (type === "demo") {
      const demo = accounts.find(account => {
        const accountType = String(
          account.account_type || ""
        ).toLowerCase();

        const loginid = String(
          account.loginid || ""
        ).toLowerCase();

        return (
          accountType === "demo" ||
          loginid.startsWith("vrt")
        );
      });

      if (demo) return demo;
    }

    if (type === "real") {
      const real = accounts.find(account => {
        const accountType = String(
          account.account_type || ""
        ).toLowerCase();

        const loginid = String(
          account.loginid || ""
        ).toLowerCase();

        return (
          accountType === "real" ||
          (
            loginid &&
            !loginid.startsWith("vrt")
          )
        );
      });

      if (real) return real;
    }

    return null;
  }

  /*
   * Create authenticated Deriv WebSocket.
   */
  async function createWebSocket(account) {
    const id = accountId(account);

    if (!id) {
      throw new Error(
        "Deriv returned an account without an account ID."
      );
    }

    const response = await fetch(
      DERIV_API +
      `/trading/v1/options/accounts/${encodeURIComponent(id)}/otp`,
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
        "Could not create Deriv trading connection."
      );
    }

    return new WebSocket(data.data.url);
  }

  /*
   * Send one WebSocket request and wait for response.
   */
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

      const finish = (fn, value) => {
        if (finished) return;

        finished = true;
        clearTimeout(timeout);

        fn(value);
      };

      ws.addEventListener("message", event => {
        try {
          const data = JSON.parse(event.data);

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
            data.msg_type === expectedMessage
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
            "Deriv WebSocket connection failed."
          )
        );
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
     * ============================================
     * GET
     * ============================================
     */
    if (request.method === "GET") {
      const data = await getAccounts();

      const accounts = extractAccounts(data);

      if (!accounts.length) {
        return json({
          ok: false,
          connected: true,
          error:
            "Deriv login succeeded, but no Options account was found.",
          deriv_response: data
        });
      }

      const formatted = accounts.map(account => ({
        account_id: accountId(account),
        loginid: account.loginid || null,
        account_type:
          account.account_type || null,
        currency:
          account.currency || "USD",
        status:
          account.status || "active",
        balance:
          account.balance ?? null
      }));

      const demo = findAccount(
        accounts,
        "demo"
      );

      return json({
        ok: true,
        connected: true,

        selected_account: demo
          ? {
              account_id: accountId(demo),
              loginid: demo.loginid || null,
              account_type:
                demo.account_type || "demo",
              currency:
                demo.currency || "USD",
              status:
                demo.status || "active",
              balance:
                demo.balance ?? null
            }
          : null,

        accounts: formatted,

        message:
          demo
            ? "Deriv demo account found."
            : "Deriv is connected, but no demo account was found."
      });
    }

    /*
     * ============================================
     * POST ONLY
     * ============================================
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

    const body = await request.json();

    const requestedType = String(
      body.account_type || "demo"
    ).toLowerCase();

    /*
     * ============================================
     * GET ACCOUNT
     * ============================================
     */
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
            "No Deriv Options account was returned."
        },
        404
      );
    }

    const account = findAccount(
      accounts,
      requestedType,
      body.account_id
    );

    if (!account) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            `No ${requestedType} Deriv Options account was found.`,
          accounts: accounts.map(a => ({
            account_id: accountId(a),
            loginid: a.loginid || null,
            account_type:
              a.account_type || null,
            currency:
              a.currency || "USD",
            status:
              a.status || "active"
          }))
        },
        404
      );
    }

    const id = accountId(account);

    if (!id) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Deriv account was found, but no account ID was returned."
        },
        400
      );
    }

    /*
     * ============================================
     * ACCOUNT INFORMATION
     * ============================================
     */
    if (body.action === "account") {
      return json({
        ok: true,
        connected: true,

        account: {
          account_id: id,
          loginid:
            account.loginid || null,
          account_type:
            account.account_type || requestedType,
          currency:
            account.currency || "USD",
          status:
            account.status || "active",
          balance:
            account.balance ?? null
        }
      });
    }

    /*
     * ============================================
     * PROPOSAL
     * ============================================
     */
    if (body.action === "proposal") {
      const ws =
        await createWebSocket(account);

      try {
        const contractType =
          String(
            body.contract_type || ""
          ).toUpperCase();

        if (!contractType) {
          throw new Error(
            "Contract type is required."
          );
        }

        const requestData = {
          proposal: 1,

          amount:
            Number(body.stake) || 1,

          basis: "stake",

          contract_type:
            contractType,

          currency:
            account.currency || "USD",

          duration:
            Number(body.duration) || 1,

          duration_unit:
            body.duration_unit || "t",

          underlying_symbol:
            body.market,

          req_id: Date.now()
        };

        /*
         * Digit contracts need a barrier.
         */
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
          requestData.barrier = String(
            body.barrier ?? 5
          );
        }

        const result =
          await wsRequest(
            ws,
            requestData,
            "proposal"
          );

        const proposal =
          result.proposal;

        if (!proposal?.id) {
          throw new Error(
            "Deriv returned a proposal without a proposal ID."
          );
        }

        return json({
          ok: true,
          connected: true,

          account: {
            account_id: id,
            account_type:
              account.account_type ||
              requestedType,
            currency:
              account.currency || "USD"
          },

          proposal: {
            id: proposal.id,
            ask_price:
              proposal.ask_price ?? null,
            payout:
              proposal.payout ?? null,
            spot:
              proposal.spot ?? null
          },

          message:
            "Fresh proposal received. Buy it immediately."
        });

      } finally {
        try {
          ws.close();
        } catch {}
      }
    }

    /*
     * ============================================
     * BUY DEMO CONTRACT
     * ============================================
     */
    if (body.action === "buy") {
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

      const isReal =
        String(
          account.account_type || ""
        ).toLowerCase() === "real";

      if (
        isReal &&
        body.confirm_real !== true
      ) {
        return json(
          {
            ok: false,
            connected: true,
            real_account: true,
            requires_confirmation: true,
            error:
              "Real account selected. Confirmation required."
          },
          400
        );
      }

      const ws =
        await createWebSocket(account);

      try {
        const buyRequest = {
          buy: String(
            body.proposal_id
          ),

          price: price,

          req_id: Date.now()
        };

        const result =
          await wsRequest(
            ws,
            buyRequest,
            "buy"
          );

        const buy =
          result.buy;

        if (!buy) {
          throw new Error(
            "Deriv did not return a purchase result."
          );
        }

        return json({
          ok: true,
          connected: true,
          purchased: true,

          account: {
            account_id: id,
            account_type:
              account.account_type ||
              requestedType,
            currency:
              account.currency || "USD"
          },

          contract: {
            contract_id:
              buy.contract_id ?? null,
            buy_price:
              buy.buy_price ?? null,
            payout:
              buy.payout ?? null,
            balance_after:
              buy.balance_after ?? null,
            transaction_id:
              buy.transaction_id ?? null,
            purchase_time:
              buy.purchase_time ?? null,
            start_time:
              buy.start_time ?? null,
            longcode:
              buy.longcode ?? null
          },

          message:
            isReal
              ? "REAL contract purchased successfully."
              : "DEMO contract purchased successfully."
        });

      } finally {
        try {
          ws.close();
        } catch {}
      }
    }

    /*
     * ============================================
     * UNKNOWN ACTION
     * ============================================
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
