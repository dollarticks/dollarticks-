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
        error:
          "No Deriv login session found. Connect Deriv again."
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

    const data = await response.json().catch(() => ({}));

    return {
      response,
      data
    };
  }

  /*
   * =====================================================
   * NORMALIZE ACCOUNT OBJECT
   * =====================================================
   */

  function normalizeAccount(account) {
    if (!account || typeof account !== "object") {
      return null;
    }

    const id =
      account.account_id ||
      account.loginid ||
      account.id ||
      null;

    if (!id) {
      return null;
    }

    let type =
      account.account_type ||
      null;

    if (!type && account.loginid) {
      const loginid =
        String(account.loginid).toLowerCase();

      if (loginid.startsWith("vrt")) {
        type = "demo";
      } else {
        type = "real";
      }
    }

    return {
      ...account,

      account_id: String(id),

      account_type:
        type || "demo",

      currency:
        account.currency || "USD",

      status:
        account.status || "active"
    };
  }

  /*
   * =====================================================
   * EXTRACT ACCOUNTS
   *
   * Handles:
   *
   * data: {...}
   * data: [{...}]
   * accounts: [...]
   * nested responses
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

      /*
       * Direct account object.
       */

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
        const account =
          normalizeAccount(value);

        if (account) {
          found.push(account);
        }
      }

      /*
       * Search nested objects.
       */

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

    /*
     * Remove duplicate accounts.
     */

    const unique = [];
    const seen = new Set();

    for (const account of found) {
      const id =
        account.account_id;

      if (!id) continue;

      if (!seen.has(id)) {
        seen.add(id);
        unique.push(account);
      }
    }

    return unique;
  }

  /*
   * =====================================================
   * ACCOUNT ID
   * =====================================================
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
   * =====================================================
   * FIND ACCOUNT
   * =====================================================
   */

  function findAccount(
    accounts,
    requestedType = "demo",
    requestedId = null
  ) {
    /*
     * Exact account ID wins.
     */

    if (requestedId) {
      const exact = accounts.find(
        account =>
          String(getAccountId(account)) ===
          String(requestedId)
      );

      if (exact) {
        return exact;
      }
    }

    const type =
      String(requestedType)
        .toLowerCase();

    /*
     * Match account_type.
     */

    const directMatch =
      accounts.find(
        account =>
          String(
            account.account_type || ""
          ).toLowerCase() === type
      );

    if (directMatch) {
      return directMatch;
    }

    /*
     * Demo fallback:
     * VRT login IDs are demo accounts.
     */

    if (type === "demo") {
      const vrt =
        accounts.find(account =>
          String(
            account.loginid || ""
          )
            .toLowerCase()
            .startsWith("vrt")
        );

      if (vrt) {
        return vrt;
      }
    }

    /*
     * Real fallback:
     * non-VRT login IDs.
     */

    if (type === "real") {
      const real =
        accounts.find(account => {
          const loginid =
            String(
              account.loginid || ""
            ).toLowerCase();

          return (
            loginid &&
            !loginid.startsWith("vrt")
          );
        });

      if (real) {
        return real;
      }
    }

    return null;
  }

  /*
   * =====================================================
   * CREATE AUTHENTICATED WEBSOCKET
   * =====================================================
   */

  async function createWebSocket(account) {
    const id =
      getAccountId(account);

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
          Authorization:
            `Bearer ${accessToken}`,

          "Deriv-App-ID":
            clientId,

          "Content-Type":
            "application/json"
        }
      }
    );

    const data =
      await response.json().catch(() => ({}));

    if (
      !response.ok ||
      !data.data?.url
    ) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Could not create authenticated Deriv WebSocket."
      );
    }

    return new WebSocket(
      data.data.url
    );
  }

  /*
   * =====================================================
   * WEBSOCKET REQUEST
   * =====================================================
   */

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeoutMs = 15000
  ) {
    return new Promise(
      (resolve, reject) => {
        let finished = false;

        const timeout =
          setTimeout(() => {
            finish(
              reject,
              new Error(
                "Deriv WebSocket request timed out."
              )
            );
          }, timeoutMs);

        function finish(
          callback,
          value
        ) {
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
            finish(
              reject,
              error
            );
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
      }
    );
  }

  /*
   * =====================================================
   * BUILD PROPOSAL REQUEST
   * =====================================================
   */

  function buildProposalRequest(
    body,
    account
  ) {
    const contractType =
      String(
        body.contract_type || ""
      ).toUpperCase();

    if (!contractType) {
      throw new Error(
        "Contract type is required."
      );
    }

    const market =
      String(
        body.market || ""
      );

    if (!market) {
      throw new Error(
        "Market is required."
      );
    }

    const stake =
      Number(body.stake);

    if (
      !Number.isFinite(stake) ||
      stake <= 0
    ) {
      throw new Error(
        "Stake must be greater than zero."
      );
    }

    const duration =
      Number(body.duration);

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error(
        "Duration must be greater than zero."
      );
    }

    const proposal = {
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
      "DIGITDIFF",
      "DIGITEVEN",
      "DIGITODD"
    ];

    if (
      digitContracts.includes(
        contractType
      )
    ) {
      proposal.barrier =
        String(
          body.barrier ?? 5
        );
    }

    return proposal;
  }

  /*
   * =====================================================
   * GET SELECTED ACCOUNT
   * =====================================================
   */

  async function getSelectedAccount(
    requestedType,
    requestedId
  ) {
    const result =
      await getAccounts();

    if (
      !result.response.ok
    ) {
      throw new Error(
        result.data.errors?.[0]?.message ||
        result.data.error?.message ||
        `Deriv account request failed with HTTP ${result.response.status}.`
      );
    }

    const accounts =
      extractAccounts(
        result.data
      );

    if (!accounts.length) {
      const raw =
        JSON.stringify(
          result.data
        );

      throw new Error(
        "Deriv connected successfully, but the Options account list was empty. Deriv response: " +
        raw
      );
    }

    const account =
      findAccount(
        accounts,
        requestedType,
        requestedId
      );

    if (!account) {
      throw new Error(
        `No ${requestedType} Deriv Options account was found. Available accounts: ` +
        JSON.stringify(
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
              a.status || "active"
          }))
        )
      );
    }

    return {
      account,
      accounts
    };
  }

  /*
   * =====================================================
   * MAIN REQUEST
   * =====================================================
   */

  try {
    /*
     * ===================================================
     * GET /trading
     * ===================================================
     */

    if (
      request.method === "GET"
    ) {
      const result =
        await getAccounts();

      if (
        !result.response.ok
      ) {
        return json(
          {
            ok: false,

            connected: false,

            error:
              result.data.errors?.[0]?.message ||
              result.data.error?.message ||
              "Deriv rejected the account request.",

            http_status:
              result.response.status,

            deriv_response:
              result.data
          },
          result.response.status
        );
      }

      const accounts =
        extractAccounts(
          result.data
        );

      /*
       * IMPORTANT:
       * Return the raw response when no account
       * can be detected. This makes the problem
       * visible instead of hiding it.
       */

      if (!accounts.length) {
        return json(
          {
            ok: false,

            connected: true,

            error:
              "Deriv login succeeded, but no Options account was detected.",

            deriv_response:
              result.data
          },
          404
        );
      }

      const demo =
        findAccount(
          accounts,
          "demo"
        );

      const formatted =
        accounts.map(
          account => ({
            account_id:
              getAccountId(account),

            loginid:
              account.loginid || null,

            account_type:
              account.account_type || null,

            currency:
              account.currency || "USD",

            status:
              account.status || "active",

            balance:
              account.balance ?? null
          })
        );

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
                  demo.account_type ||
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
          formatted,

        message:
          demo
            ? "Deriv Options demo account found."
            : "Deriv is connected, but no demo account was detected."
      });
    }

    /*
     * ===================================================
     * POST ONLY
     * ===================================================
     */

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

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Invalid JSON request."
        },
        400
      );
    }

    const requestedType =
      String(
        body.account_type ||
        "demo"
      ).toLowerCase();

    if (
      requestedType !== "demo" &&
      requestedType !== "real"
    ) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Account type must be demo or real."
        },
        400
      );
    }

    /*
     * Get account.
     */

    const selected =
      await getSelectedAccount(
        requestedType,
        body.account_id
      );

    const account =
      selected.account;

    const id =
      getAccountId(account);

    /*
     * ===================================================
     * ACCOUNT INFORMATION
     * ===================================================
     */

    if (
      body.action === "account"
    ) {
      return json({
        ok: true,

        connected: true,

        account: {
          account_id:
            id,

          loginid:
            account.loginid || null,

          account_type:
            account.account_type ||
            requestedType,

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
     * ===================================================
     * PROPOSAL
     * ===================================================
     */

    if (
      body.action === "proposal"
    ) {
      const ws =
        await createWebSocket(
          account
        );

      try {
        const proposalRequest =
          buildProposalRequest(
            body,
            account
          );

        const result =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal",
            15000
          );

        const proposal =
          result.proposal;

        if (
          !proposal ||
          !proposal.id
        ) {
          throw new Error(
            "Deriv returned a proposal without a valid proposal ID."
          );
        }

        return json({
          ok: true,

          connected: true,

          account: {
            account_id:
              id,

            loginid:
              account.loginid ||
              null,

            account_type:
              account.account_type ||
              requestedType,

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
              null,

            display_value:
              proposal.display_value ??
              null
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
     * ===================================================
     * BUY
     * ===================================================
     *
     * The frontend normally sends the proposal ID
     * and ask price.
     *
     * If the proposal has expired, the response will
     * clearly tell the frontend to request another one.
     * ===================================================
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

      const isReal =
        String(
          account.account_type ||
          requestedType
        ).toLowerCase() ===
        "real";

      /*
       * Never allow accidental real-money
       * purchase without explicit confirmation.
       */

      if (
        isReal &&
        body.confirm_real !== true
      ) {
        return json(
          {
            ok: false,

            connected: true,

            real_account: true,

            requires_confirmation:
              true,

            error:
              "Real account selected. Explicit confirmation is required before purchasing."
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

          subscribe:
            1,

          req_id:
            Date.now()
        };

        const result =
          await wsRequest(
            ws,
            buyRequest,
            "buy",
            15000
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

          real_account:
            isReal,

          account: {
            account_id:
              id,

            loginid:
              account.loginid ||
              null,

            account_type:
              account.account_type ||
              requestedType,

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
     * ===================================================
     * RESET DEMO BALANCE
     * ===================================================
     */

    if (
      body.action ===
      "reset_demo_balance"
    ) {
      const isReal =
        String(
          account.account_type ||
          requestedType
        ).toLowerCase() ===
        "real";

      if (isReal) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Real account balances cannot be reset."
          },
          400
        );
      }

      const response =
        await fetch(
          DERIV_API +
          `/trading/v1/options/accounts/${encodeURIComponent(id)}/reset-demo-balance`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Deriv-App-ID":
                clientId,

              "Content-Type":
                "application/json"
            }
          }
        );

      const data =
        await response.json()
          .catch(() => ({}));

      if (!response.ok) {
        return json(
          {
            ok: false,

            connected: true,

            error:
              data.errors?.[0]?.message ||
              data.error?.message ||
              "Could not reset demo balance.",

            deriv_response:
              data
          },
          response.status
        );
      }

      return json({
        ok: true,

        connected: true,

        account_type:
          "demo",

        message:
          "Demo balance reset successfully."
      });
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
