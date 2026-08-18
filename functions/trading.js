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
        error: "No Deriv login session found. Connect Deriv again."
      },
      401
    );
  }

  const clientId = "347btQbpUS2La9uhcLb2X";
  const DERIV_API = "https://api.derivws.com";

  function findAccounts(data) {
    const found = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        value.forEach(scan);
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

      Object.values(value).forEach(child => {
        if (child && typeof child === "object") {
          scan(child);
        }
      });
    }

    scan(data);

    const unique = [];
    const ids = new Set();

    for (const account of found) {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) continue;

      if (!ids.has(String(id))) {
        ids.add(String(id));
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

  async function getAccounts() {
    const response = await fetch(
      DERIV_API + "/trading/v1/options/accounts",
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Deriv-App-ID": clientId,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    return {
      response,
      data,
      accounts: findAccounts(data)
    };
  }

  function selectAccount(accounts, requestedType, requestedId) {
    if (requestedId) {
      const exact = accounts.find(
        account =>
          String(getAccountId(account)) ===
          String(requestedId)
      );

      if (exact) return exact;
    }

    const type = String(
      requestedType || "demo"
    ).toLowerCase();

    const matching = accounts.filter(
      account =>
        String(account.account_type || "").toLowerCase() === type
    );

    return (
      matching.find(
        account =>
          String(account.status || "").toLowerCase() === "active"
      ) ||
      matching[0] ||
      null
    );
  }

  async function getSelectedAccount(type, id) {
    const result = await getAccounts();

    if (!result.response.ok) {
      throw new Error(
        result.data?.errors?.[0]?.message ||
        "Could not retrieve Deriv accounts."
      );
    }

    if (!result.accounts.length) {
      throw new Error(
        "No Deriv Options accounts were returned."
      );
    }

    const account = selectAccount(
      result.accounts,
      type,
      id
    );

    if (!account) {
      throw new Error(
        `No ${type || "demo"} Deriv Options account was found.`
      );
    }

    return account;
  }

  async function createAuthenticatedWS(accountId) {
    const response = await fetch(
      DERIV_API +
        `/trading/v1/options/accounts/${encodeURIComponent(
          accountId
        )}/otp`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
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

  function sendWS(ws, payload, expectedType, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let done = false;

      const finish = (fn, value) => {
        if (done) return;

        done = true;
        clearTimeout(timer);

        try {
          ws.removeEventListener("message", onMessage);
        } catch {}

        fn(value);
      };

      const timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            "Deriv WebSocket request timed out."
          )
        );
      }, timeoutMs);

      const onMessage = event => {
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

          if (data.msg_type === expectedType) {
            finish(resolve, data);
          }
        } catch (error) {
          finish(reject, error);
        }
      };

      ws.addEventListener("message", onMessage);

      const send = () => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (error) {
          finish(reject, error);
        }
      };

      if (ws.readyState === WebSocket.OPEN) {
        send();
      } else {
        ws.addEventListener("open", send, { once: true });

        ws.addEventListener(
          "error",
          () => {
            finish(
              reject,
              new Error(
                "Deriv WebSocket connection failed."
              )
            );
          },
          { once: true }
        );
      }
    });
  }

  try {
    /*
     * =====================================================
     * GET
     * =====================================================
     */

    if (request.method === "GET") {
      const result = await getAccounts();

      if (!result.response.ok) {
        return json(
          {
            ok: false,
            connected: false,
            error: "Deriv rejected the account request.",
            deriv_response: result.data
          },
          result.response.status
        );
      }

      const accounts = result.accounts.map(account => ({
        account_id: getAccountId(account),
        account_type: account.account_type || null,
        currency: account.currency || "USD",
        status: account.status || "active",
        balance: account.balance ?? null
      }));

      const demo = selectAccount(
        result.accounts,
        "demo"
      );

      return json({
        ok: true,
        connected: true,

        selected_account: demo
          ? {
              account_id: getAccountId(demo),
              account_type: demo.account_type || null,
              currency: demo.currency || "USD",
              status: demo.status || "active",
              balance: demo.balance ?? null
            }
          : null,

        accounts,

        message:
          "Deriv Options account is connected."
      });
    }

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

    if (
      requestedType !== "demo" &&
      requestedType !== "real"
    ) {
      return json(
        {
          ok: false,
          error:
            "Account type must be demo or real."
        },
        400
      );
    }

    const account = await getSelectedAccount(
      requestedType,
      body.account_id
    );

    const accountId = getAccountId(account);

    if (!accountId) {
      return json(
        {
          ok: false,
          error: "Deriv account ID was not found."
        },
        400
      );
    }

    const isReal =
      String(account.account_type || "").toLowerCase() ===
      "real";

    /*
     * =====================================================
     * ACCOUNT
     * =====================================================
     */

    if (body.action === "account") {
      return json({
        ok: true,
        connected: true,

        account: {
          account_id: accountId,
          account_type: account.account_type || null,
          currency: account.currency || "USD",
          status: account.status || "active",
          balance: account.balance ?? null
        }
      });
    }

    /*
     * =====================================================
     * PROPOSAL
     * =====================================================
     */

    if (body.action === "proposal") {
      const ws = await createAuthenticatedWS(accountId);

      try {
        const contractType = String(
          body.contract_type || ""
        ).toUpperCase();

        if (!contractType) {
          throw new Error(
            "Contract type is required."
          );
        }

        if (!body.market) {
          throw new Error(
            "Market is required."
          );
        }

        const digitContracts = [
          "DIGITOVER",
          "DIGITUNDER",
          "DIGITMATCH",
          "DIGITDIFF",
          "DIGITEVEN",
          "DIGITODD"
        ];

        const proposalRequest = {
          proposal: 1,

          amount:
            Number(body.stake) > 0
              ? Number(body.stake)
              : 1,

          basis: "stake",

          contract_type: contractType,

          currency:
            account.currency || "USD",

          duration:
            Number(body.duration) > 0
              ? Number(body.duration)
              : 1,

          duration_unit:
            body.duration_unit || "t",

          underlying_symbol:
            body.market,

          passthrough: {
            source: "DollarTicks"
          }
        };

        if (
          digitContracts.includes(contractType)
        ) {
          proposalRequest.barrier =
            String(body.barrier ?? 5);
        }

        /*
         * IMPORTANT:
         * Ask Deriv for a fresh proposal every time.
         */

        const data = await sendWS(
          ws,
          proposalRequest,
          "proposal",
          15000
        );

        const proposal = data.proposal || {};

        if (!proposal.id) {
          throw new Error(
            "Deriv returned a proposal without an ID."
          );
        }

        return json({
          ok: true,
          connected: true,

          account: {
            account_id: accountId,
            account_type:
              account.account_type || null,
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
              proposal.spot ?? null,
            display_value:
              proposal.display_value ?? null,
            contract_type: contractType,
            market: body.market
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
     * =====================================================
     * BUY
     * =====================================================
     *
     * The frontend must send the NEW proposal ID
     * and the exact ask price returned by proposal.
     *
     * =====================================================
     */

    if (body.action === "buy") {
      if (!body.proposal_id) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "Fresh proposal ID is required."
          },
          400
        );
      }

      const price = Number(body.price);

      if (!Number.isFinite(price) || price <= 0) {
        return json(
          {
            ok: false,
            connected: true,
            error:
              "The proposal ask price is required."
          },
          400
        );
      }

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
              "Real account selected. Explicit confirmation is required before buying."
          },
          400
        );
      }

      /*
       * IMPORTANT:
       * Create a NEW authenticated connection.
       *
       * The proposal must still be valid at the moment
       * Deriv receives the buy request.
       */

      const ws = await createAuthenticatedWS(accountId);

      try {
        const buyRequest = {
          buy: String(body.proposal_id),
          price: price,
          req_id:
            Date.now()
        };

        const data = await sendWS(
          ws,
          buyRequest,
          "buy",
          15000
        );

        const buy = data.buy || null;

        if (!buy) {
          throw new Error(
            "Deriv did not return a buy result."
          );
        }

        return json({
          ok: true,
          connected: true,
          purchased: true,
          real_account: isReal,

          account: {
            account_id: accountId,
            account_type:
              account.account_type || null,
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

          message: isReal
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
     * =====================================================
     * UNKNOWN ACTION
     * =====================================================
     */

    return json(
      {
        ok: false,
        connected: true,
        error: "Unknown trading action."
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
