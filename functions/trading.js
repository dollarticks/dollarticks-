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

  // =====================================================
  // GET ACCESS TOKEN
  // =====================================================

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

  // =====================================================
  // CONFIG
  // =====================================================

  const clientId = "347btQbpUS2La9uhcLb2X";
  const DERIV_API = "https://api.derivws.com";

  // =====================================================
  // ACCOUNT HELPERS
  // =====================================================

  function getAccountId(account) {
    return (
      account?.account_id ||
      account?.loginid ||
      account?.id ||
      null
    );
  }

  function findAccounts(data) {
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
    const ids = new Set();

    for (const account of found) {
      const id = getAccountId(account);

      if (!id) continue;

      if (!ids.has(String(id))) {
        ids.add(String(id));
        unique.push(account);
      }
    }

    return unique;
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

  function selectAccount(
    accounts,
    requestedType = "demo",
    requestedId = null
  ) {
    // Exact account ID first
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

    const type = String(
      requestedType || "demo"
    ).toLowerCase();

    const matching = accounts.filter(
      account =>
        String(
          account.account_type || ""
        ).toLowerCase() === type
    );

    return (
      matching.find(
        account =>
          String(
            account.status || ""
          ).toLowerCase() === "active"
      ) ||
      matching[0] ||
      null
    );
  }

  async function getSelectedAccount(
    requestedType,
    requestedId
  ) {
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
      requestedType,
      requestedId
    );

    if (!account) {
      throw new Error(
        `No ${requestedType || "demo"} Deriv Options account was found.`
      );
    }

    return account;
  }

  // =====================================================
  // CREATE AUTHENTICATED DERIV WEBSOCKET
  // =====================================================

  async function createAuthenticatedWS(accountId) {
    const otpResponse = await fetch(
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

    const otpData = await otpResponse.json();

    if (
      !otpResponse.ok ||
      !otpData?.data?.url
    ) {
      throw new Error(
        otpData?.errors?.[0]?.message ||
        otpData?.error?.message ||
        "Could not create authenticated Deriv WebSocket."
      );
    }

    // Deriv gives us a ready-to-use authenticated URL.
    return new WebSocket(
      otpData.data.url
    );
  }

  // =====================================================
  // WEBSOCKET REQUEST
  // =====================================================

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeoutMs = 15000
  ) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let timeout;

      const finish = (callback, value) => {
        if (finished) return;

        finished = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        callback(value);
      };

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

          if (
            data.msg_type === expectedMessage
          ) {
            finish(resolve, data);
          }

        } catch (error) {
          finish(reject, error);
        }
      };

      const onError = () => {
        finish(
          reject,
          new Error(
            "Authenticated Deriv WebSocket connection failed."
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

      timeout = setTimeout(() => {
        finish(
          reject,
          new Error(
            "Deriv WebSocket request timed out."
          )
        );
      }, timeoutMs);

      const sendRequest = () => {
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
        sendRequest();
      } else {
        ws.addEventListener(
          "open",
          sendRequest,
          { once: true }
        );
      }
    });
  }

  // =====================================================
  // NORMALIZE MARKET SYMBOL
  // =====================================================

  function normalizeMarket(market) {
    const value = String(
      market || ""
    ).trim();

    const map = {
      "Volatility 10": "1HZ10V",
      "Volatility 25": "1HZ25V",
      "Volatility 50": "1HZ50V",
      "Volatility 75": "1HZ75V",
      "Volatility 100": "1HZ100V",

      "Volatility 10 (1s)": "1HZ10V",
      "Volatility 25 (1s)": "1HZ25V",
      "Volatility 50 (1s)": "1HZ50V",
      "Volatility 75 (1s)": "1HZ75V",
      "Volatility 100 (1s)": "1HZ100V"
    };

    return map[value] || value;
  }

  // =====================================================
  // MAIN
  // =====================================================

  try {

    // ===================================================
    // GET
    // ===================================================

    if (request.method === "GET") {

      const result = await getAccounts();

      if (!result.response.ok) {
        return json(
          {
            ok: false,
            connected: false,
            error:
              "Deriv rejected the account request.",
            deriv_response: result.data
          },
          result.response.status
        );
      }

      if (!result.accounts.length) {
        return json({
          ok: false,
          connected: true,
          error:
            "Deriv login succeeded, but no Options account was returned.",
          deriv_response: result.data
        });
      }

      const accounts =
        result.accounts.map(account => ({
          account_id:
            getAccountId(account),

          account_type:
            account.account_type || null,

          currency:
            account.currency || "USD",

          status:
            account.status || "active",

          balance:
            account.balance ?? null
        }));

      const selected =
        selectAccount(
          result.accounts,
          "demo"
        );

      return json({
        ok: true,
        connected: true,

        selected_account:
          selected
            ? {
                account_id:
                  getAccountId(selected),

                account_type:
                  selected.account_type || null,

                currency:
                  selected.currency || "USD",

                status:
                  selected.status || "active",

                balance:
                  selected.balance ?? null
              }
            : null,

        accounts,

        message:
          "Deriv Options account is connected."
      });
    }

    // ===================================================
    // ONLY POST AFTER THIS POINT
    // ===================================================

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

    const requestedType =
      String(
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

    const account =
      await getSelectedAccount(
        requestedType,
        body.account_id
      );

    const accountId =
      getAccountId(account);

    if (!accountId) {
      return json(
        {
          ok: false,
          error:
            "No account ID was returned by Deriv."
        },
        400
      );
    }

    const accountType =
      String(
        account.account_type || ""
      ).toLowerCase();

    const isReal =
      accountType === "real";

    // ===================================================
    // ACCOUNT
    // ===================================================

    if (body.action === "account") {
      return json({
        ok: true,
        connected: true,

        account: {
          account_id: accountId,

          account_type:
            account.account_type || null,

          currency:
            account.currency || "USD",

          status:
            account.status || "active",

          balance:
            account.balance ?? null
        }
      });
    }

    // ===================================================
    // RESET DEMO BALANCE
    // ===================================================

    if (
      body.action ===
      "reset_demo_balance"
    ) {

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

      const resetResponse =
        await fetch(
          DERIV_API +
            `/trading/v1/options/accounts/${encodeURIComponent(
              accountId
            )}/reset-demo-balance`,
          {
            method: "POST",
            headers: {
              "Authorization":
                `Bearer ${accessToken}`,

              "Deriv-App-ID":
                clientId,

              "Content-Type":
                "application/json"
            }
          }
        );

      const resetData =
        await resetResponse.json()
          .catch(() => ({}));

      if (!resetResponse.ok) {
        return json(
          {
            ok: false,
            connected: true,

            error:
              resetData?.errors?.[0]?.message ||
              "Could not reset demo balance.",

            deriv_response:
              resetData
          },
          resetResponse.status
        );
      }

      return json({
        ok: true,
        connected: true,
        account_type: "demo",

        message:
          "Demo balance reset successfully."
      });
    }

    // ===================================================
    // PROPOSAL
    // ===================================================

    if (body.action === "proposal") {

      const market =
        normalizeMarket(body.market);

      if (!market) {
        return json(
          {
            ok: false,
            error:
              "A market symbol is required."
          },
          400
        );
      }

      const contractType =
        String(
          body.contract_type || ""
        ).toUpperCase();

      if (!contractType) {
        return json(
          {
            ok: false,
            error:
              "A contract type is required."
          },
          400
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
          market,

        req_id: 1001
      };

      // Digit contracts need a barrier.
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

      const ws =
        await createAuthenticatedWS(
          accountId
        );

      try {

        const data =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal",
            15000
          );

        const proposal =
          data.proposal || {};

        if (!proposal.id) {
          return json(
            {
              ok: false,
              connected: true,

              error:
                "Deriv returned a proposal response without a proposal ID.",

              deriv_response:
                data
            },
            502
          );
        }

        return json({
          ok: true,
          connected: true,

          account: {
            account_id:
              accountId,

            account_type:
              account.account_type || null,

            currency:
              account.currency || "USD"
          },

          proposal: {
            id:
              proposal.id,

            ask_price:
              proposal.ask_price ?? null,

            payout:
              proposal.payout ?? null,

            spot:
              proposal.spot ?? null
          },

          request: {
            market,
            contract_type:
              contractType,

            stake:
              Number(body.stake) || 1,

            duration:
              Number(body.duration) || 1,

            duration_unit:
              body.duration_unit || "t",

            barrier:
              body.barrier ?? null
          },

          message:
            "Proposal received. No contract was purchased."
        });

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    // ===================================================
    // BUY
    // ===================================================

    if (body.action === "buy") {

      const proposalId =
        String(
          body.proposal_id || ""
        ).trim();

      const price =
        Number(body.price);

      if (!proposalId) {
        return json(
          {
            ok: false,
            connected: true,

            error:
              "A proposal ID is required. Get a new proposal before buying."
          },
          400
        );
      }

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return json(
          {
            ok: false,
            connected: true,

            error:
              "A valid proposal price is required."
          },
          400
        );
      }

      // Safety check for real account.
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
        await createAuthenticatedWS(
          accountId
        );

      try {

        const buyRequest = {
          buy: proposalId,

          price: price,

          subscribe: 1,

          req_id: 2001
        };

        const data =
          await wsRequest(
            ws,
            buyRequest,
            "buy",
            15000
          );

        const buy =
          data.buy || null;

        if (!buy) {
          return json(
            {
              ok: false,
              connected: true,

              error:
                "Deriv did not return a buy result.",

              deriv_response:
                data
            },
            502
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
              accountId,

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

          message:
            isReal
              ? "REAL contract purchased successfully."
              : "DEMO contract purchased successfully."
        });

      } catch (error) {

        const message =
          String(
            error?.message || ""
          );

        // Give a useful message instead of
        // the confusing raw error.
        if (
          message
            .toLowerCase()
            .includes("unknown") &&
          message
            .toLowerCase()
            .includes("proposal")
        ) {
          return json(
            {
              ok: false,
              connected: true,

              error:
                "This proposal is no longer valid. Get a fresh proposal and buy it immediately."
            },
            400
          );
        }

        throw error;

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    // ===================================================
    // UNKNOWN ACTION
    // ===================================================

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
