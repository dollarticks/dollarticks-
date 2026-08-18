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

  const APP_ID =
    "347btQbpUS2La9uhcLb2X";

  const API =
    "https://api.derivws.com";

  const VALID_MARKETS = [
    "1HZ100V",
    "1HZ75V",
    "1HZ50V",
    "1HZ25V",
    "1HZ10V"
  ];

  const DIGIT_CONTRACTS = [
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITDIFF",
    "DIGITEVEN",
    "DIGITODD"
  ];

  /* =====================================================
     GET DERIV ACCOUNTS
  ===================================================== */

  async function getAccounts() {
    const response =
      await fetch(
        `${API}/trading/v1/options/accounts`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Deriv-App-ID":
              APP_ID,

            Accept:
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Deriv rejected the account request."
      );
    }

    return data;
  }

  /* =====================================================
     EXTRACT ACCOUNTS
  ===================================================== */

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

      for (
        const child of Object.values(value)
      ) {
        if (
          child &&
          typeof child === "object"
        ) {
          scan(child);
        }
      }
    }

    scan(data);

    const seen =
      new Set();

    return found.filter(
      account => {
        const id =
          account.account_id ||
          account.loginid ||
          account.id;

        if (!id) {
          return false;
        }

        const key =
          String(id);

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      }
    );
  }

  function accountId(account) {
    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }

  /* =====================================================
     FIND DEMO ACCOUNT
  ===================================================== */

  function findDemo(accounts) {
    return accounts.find(
      account => {
        const type =
          String(
            account.account_type ||
            ""
          ).toLowerCase();

        const loginid =
          String(
            account.loginid ||
            ""
          ).toLowerCase();

        return (
          type === "demo" ||
          loginid.startsWith("vrt") ||
          loginid.startsWith("dot")
        );
      }
    );
  }

  /* =====================================================
     AUTHENTICATED WEBSOCKET
  ===================================================== */

  async function createAuthenticatedWebSocket(
    account
  ) {
    const id =
      accountId(account);

    if (!id) {
      throw new Error(
        "Deriv account ID is missing."
      );
    }

    const response =
      await fetch(
        `${API}/trading/v1/options/accounts/${encodeURIComponent(id)}/otp`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Deriv-App-ID":
              APP_ID,

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        "Deriv rejected the WebSocket authentication request."
      );
    }

    const url =
      data.data?.url;

    if (!url) {
      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    return new WebSocket(url);
  }

  /* =====================================================
     WEBSOCKET REQUEST
  ===================================================== */

  function wsRequest(
    ws,
    payload,
    expectedMessage,
    timeout = 15000
  ) {
    return new Promise(
      (resolve, reject) => {

        let finished = false;

        const timer =
          setTimeout(
            () => {
              if (finished) {
                return;
              }

              finished = true;

              reject(
                new Error(
                  `Deriv ${expectedMessage} request timed out.`
                )
              );
            },
            timeout
          );

        function finish(
          fn,
          value
        ) {
          if (finished) {
            return;
          }

          finished = true;

          clearTimeout(
            timer
          );

          try {
            ws.removeEventListener(
              "message",
              onMessage
            );
          } catch {}

          fn(value);
        }

        function onMessage(event) {
          try {
            const data =
              typeof event.data ===
              "string"
                ? JSON.parse(
                    event.data
                  )
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

        ws.addEventListener(
          "message",
          onMessage
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
          },
          { once: true }
        );

        function sendRequest() {
          try {

            if (
              ws.readyState !==
              WebSocket.OPEN
            ) {
              finish(
                reject,
                new Error(
                  "Authenticated Deriv WebSocket is not open."
                )
              );

              return;
            }

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
        }

        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {
          sendRequest();
        } else {
          ws.addEventListener(
            "open",
            sendRequest,
            { once: true }
          );
        }
      }
    );
  }

  /* =====================================================
     MARKET
  ===================================================== */

  function getMarket(body) {
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
      !VALID_MARKETS.includes(
        market
      )
    ) {
      throw new Error(
        `Invalid market "${market}". Select a Volatility market first.`
      );
    }

    return market;
  }

  /* =====================================================
     BUILD PROPOSAL
  ===================================================== */

  function buildProposalRequest(
    body,
    account,
    market
  ) {

    const contractType =
      String(
        body.contract_type ||
        "DIGITOVER"
      ).toUpperCase();

    /*
     * IMPORTANT:
     *
     * If the frontend sends nothing,
     * use 1 USD demo stake.
     */

    let stake =
      Number(
        body.stake
      );

    if (
      !Number.isFinite(stake) ||
      stake <= 0
    ) {
      stake = 1;
    }

    /*
     * Duration also gets a safe default.
     */

    let duration =
      Number(
        body.duration
      );

    if (
      !Number.isFinite(duration) ||
      duration < 1
    ) {
      duration = 1;
    }

    const requestData = {
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

    if (
      DIGIT_CONTRACTS.includes(
        contractType
      )
    ) {

      let barrier =
        String(
          body.barrier ??
          "5"
        ).trim();

      if (
        !/^[0-9]$/.test(
          barrier
        )
      ) {
        barrier = "5";
      }

      requestData.barrier =
        barrier;
    }

    return requestData;
  }

  /* =====================================================
     MAIN
  ===================================================== */

  try {

    /* ===================================================
       GET
    =================================================== */

    if (
      request.method ===
      "GET"
    ) {

      const accountData =
        await getAccounts();

      const accounts =
        extractAccounts(
          accountData
        );

      if (
        !accounts.length
      ) {
        return json({
          ok: false,
          connected: true,
          error:
            "Deriv login succeeded, but no Options account was returned."
        });
      }

      const demo =
        findDemo(
          accounts
        );

      return json({
        ok: true,

        connected: true,

        selected_account:
          demo
            ? {
                account_id:
                  accountId(
                    demo
                  ),

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
          accounts.map(
            account => ({
              account_id:
                accountId(
                  account
                ),

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
            })
          )
      });
    }

    /* ===================================================
       POST
    =================================================== */

    if (
      request.method !==
      "POST"
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

    const market =
      getMarket(body);

    const accountData =
      await getAccounts();

    const accounts =
      extractAccounts(
        accountData
      );

    const account =
      findDemo(
        accounts
      );

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

    const id =
      accountId(
        account
      );

    /* ===================================================
       ACCOUNT
    =================================================== */

    if (
      body.action ===
      "account"
    ) {

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

    /* ===================================================
       PROPOSAL
    =================================================== */

    if (
      body.action ===
      "proposal"
    ) {

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {

        const proposalRequest =
          buildProposalRequest(
            body,
            account,
            market
          );

        const result =
          await wsRequest(
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
            "Deriv returned an invalid proposal."
          );
        }

        return json({
          ok: true,

          connected: true,

          market:
            market,

          stake:
            proposalRequest.amount,

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
              String(
                proposal.id
              ),

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
            "Fresh proposal received."
        });

      } finally {

        try {
          ws.close();
        } catch {}

      }
    }

    /* ===================================================
       BUY
       
       Proposal + BUY happen on SAME WebSocket.
    =================================================== */

    if (
      body.action ===
      "buy"
    ) {

      const ws =
        await createAuthenticatedWebSocket(
          account
        );

      try {

        /*
         * Create completely fresh proposal.
         */

        const proposalRequest =
          buildProposalRequest(
            body,
            account,
            market
          );

        const proposalResult =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal"
          );

        const proposal =
          proposalResult.proposal;

        if (
          !proposal ||
          !proposal.id
        ) {
          throw new Error(
            "Deriv returned an invalid proposal."
          );
        }

        const proposalId =
          String(
            proposal.id
          );

        const askPrice =
          Number(
            proposal.ask_price
          );

        if (
          !Number.isFinite(
            askPrice
          ) ||
          askPrice <= 0
        ) {
          throw new Error(
            "Deriv returned an invalid proposal price."
          );
        }

        /*
         * Immediately buy it on the SAME
         * authenticated WebSocket.
         */

        const buyResult =
          await wsRequest(
            ws,
            {
              buy:
                proposalId,

              price:
                askPrice,

              req_id:
                Date.now()
            },
            "buy"
          );

        const buy =
          buyResult.buy;

        if (!buy) {
          throw new Error(
            "Deriv did not return a purchase result."
          );
        }

        return json({
          ok: true,

          connected: true,

          purchased: true,

          market:
            market,

          stake:
            proposalRequest.amount,

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
              proposalId,

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
