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
  // CONFIG
  // =====================================================

  const clientId = "347btQbpUS2La9uhcLb2X";
  const DERIV_API = "https://api.derivws.com";

  // =====================================================
  // COOKIE
  // =====================================================

  const cookies =
    request.headers.get("Cookie") || "";

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
  // ACCOUNT ID
  // =====================================================

  function getAccountId(account) {
    return (
      account?.account_id ||
      account?.loginid ||
      account?.id ||
      null
    );
  }

  // =====================================================
  // FIND ACCOUNTS
  // =====================================================

  function findAccounts(data) {
    const found = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        value.forEach(scan);
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

  // =====================================================
  // GET ACCOUNTS
  // =====================================================

  async function getAccounts() {
    const response = await fetch(
      DERIV_API +
        "/trading/v1/options/accounts",
      {
        method: "GET",
        headers: {
          "Authorization":
            `Bearer ${accessToken}`,

          "Deriv-App-ID":
            clientId,

          "Accept":
            "application/json"
        }
      }
    );

    const data =
      await response.json();

    return {
      response,
      data,
      accounts:
        findAccounts(data)
    };
  }

  // =====================================================
  // SELECT ACCOUNT
  // =====================================================

  function selectAccount(
    accounts,
    requestedType = "demo",
    requestedId = null
  ) {
    // Exact ID first
    if (requestedId) {
      const exact =
        accounts.find(
          account =>
            String(
              getAccountId(account)
            ) === String(requestedId)
        );

      if (exact) {
        return exact;
      }
    }

    const type =
      String(
        requestedType
      ).toLowerCase();

    const matching =
      accounts.filter(
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

  // =====================================================
  // AUTHENTICATED WEBSOCKET
  // =====================================================

  async function createAuthenticatedWS(
    accountId
  ) {
    const response =
      await fetch(
        DERIV_API +
          `/trading/v1/options/accounts/${encodeURIComponent(
            accountId
          )}/otp`,
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

    const data =
      await response.json();

    if (
      !response.ok ||
      !data?.data?.url
    ) {
      throw new Error(
        data?.errors?.[0]?.message ||
        data?.error?.message ||
        "Could not create authenticated Deriv WebSocket."
      );
    }

    return new WebSocket(
      data.data.url
    );
  }

  // =====================================================
  // WEBSOCKET SEND
  // =====================================================

  function wsSend(
    ws,
    payload,
    expected,
    timeout = 15000
  ) {
    return new Promise(
      (resolve, reject) => {

        let done = false;

        const finish = (
          fn,
          value
        ) => {
          if (done) return;

          done = true;

          clearTimeout(timer);

          fn(value);
        };

        const timer =
          setTimeout(
            () => {
              finish(
                reject,
                new Error(
                  "Deriv request timed out."
                )
              );
            },
            timeout
          );

        const messageHandler =
          event => {
            try {
              const data =
                JSON.parse(
                  event.data
                );

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
                expected
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
          };

        ws.addEventListener(
          "message",
          messageHandler
        );

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

        const send = () => {
          try {
            ws.send(
              JSON.stringify(
                payload
              )
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

  // =====================================================
  // MARKET NORMALIZATION
  // =====================================================

  function normalizeMarket(
    market
  ) {
    const value =
      String(
        market || ""
      ).trim();

    const markets = {
      "Volatility 10":
        "1HZ10V",

      "Volatility 25":
        "1HZ25V",

      "Volatility 50":
        "1HZ50V",

      "Volatility 75":
        "1HZ75V",

      "Volatility 100":
        "1HZ100V",

      "Volatility 10 (1s)":
        "1HZ10V",

      "Volatility 25 (1s)":
        "1HZ25V",

      "Volatility 50 (1s)":
        "1HZ50V",

      "Volatility 75 (1s)":
        "1HZ75V",

      "Volatility 100 (1s)":
        "1HZ100V"
    };

    return (
      markets[value] ||
      value
    );
  }

  // =====================================================
  // MAIN
  // =====================================================

  try {

    // ===================================================
    // GET
    // ===================================================

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
              "Deriv rejected the account request.",

            deriv_response:
              result.data
          },
          result.response.status
        );
      }

      if (
        !result.accounts.length
      ) {
        return json({
          ok: false,
          connected: true,

          error:
            "No Deriv Options account was found.",

          deriv_response:
            result.data
        });
      }

      const accounts =
        result.accounts.map(
          account => ({
            account_id:
              getAccountId(
                account
              ),

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
          })
        );

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
                  getAccountId(
                    selected
                  ),

                account_type:
                  selected.account_type ||
                  null,

                currency:
                  selected.currency ||
                  "USD",

                status:
                  selected.status ||
                  "active",

                balance:
                  selected.balance ??
                  null
              }
            : null,

        accounts,

        message:
          "Deriv Options account is connected."
      });
    }

    // ===================================================
    // POST ONLY
    // ===================================================

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
          error:
            "Account type must be demo or real."
        },
        400
      );
    }

    // ===================================================
    // GET ACCOUNT
    // ===================================================

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
            result.data?.errors?.[0]?.message ||
            "Could not retrieve Deriv accounts.",

          deriv_response:
            result.data
        },
        result.response.status
      );
    }

    const account =
      selectAccount(
        result.accounts,
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

          available_accounts:
            result.accounts.map(
              a => ({
                account_id:
                  getAccountId(a),

                account_type:
                  a.account_type ||
                  null,

                status:
                  a.status ||
                  null
              })
            )
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
            "Deriv returned an account without an account ID."
        },
        400
      );
    }

    const isReal =
      String(
        account.account_type ||
        ""
      ).toLowerCase() ===
      "real";

    // ===================================================
    // ACCOUNT
    // ===================================================

    if (
      body.action === "account"
    ) {
      return json({
        ok: true,
        connected: true,

        account: {
          account_id:
            accountId,

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
        }
      });
    }

    // ===================================================
    // PROPOSAL
    // ===================================================

    if (
      body.action === "proposal"
    ) {

      const market =
        normalizeMarket(
          body.market
        );

      if (!market) {
        return json(
          {
            ok: false,
            error:
              "Market is required."
          },
          400
        );
      }

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        ).toUpperCase();

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
          Number(
            body.stake
          ) || 1,

        basis:
          "stake",

        contract_type:
          contractType,

        currency:
          account.currency ||
          "USD",

        duration:
          Number(
            body.duration
          ) || 1,

        duration_unit:
          body.duration_unit ||
          "t",

        underlying_symbol:
          market,

        req_id:
          Date.now()
      };

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

      const ws =
        await createAuthenticatedWS(
          accountId
        );

      try {

        const data =
          await wsSend(
            ws,
            proposalRequest,
            "proposal"
          );

        const proposal =
          data.proposal ||
          {};

        if (!proposal.id) {
          return json(
            {
              ok: false,
              connected: true,

              error:
                "Deriv returned a proposal without a proposal ID.",

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
              account.account_type ||
              null,

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

    if (
      body.action === "buy"
    ) {

      const proposalId =
        String(
          body.proposal_id ||
          ""
        ).trim();

      const price =
        Number(
          body.price
        );

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
              "Real account selected. Confirmation is required."
          },
          400
        );
      }

      const ws =
        await createAuthenticatedWS(
          accountId
        );

      try {

        // IMPORTANT:
        // Buy the proposal immediately
        // on the authenticated socket.

        const buyRequest = {
          buy:
            proposalId,

          price:
            price,

          req_id:
            Date.now()
        };

        const data =
          await wsSend(
            ws,
            buyRequest,
            "buy",
            15000
          );

        const buy =
          data.buy ||
          null;

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
              account.account_type ||
              null,

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

      } catch (error) {

        return json(
          {
            ok: false,
            connected: true,

            error:
              error?.message ||
              "Deriv rejected the purchase."
          },
          400
        );

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
