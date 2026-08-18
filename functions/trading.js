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
  const CLIENT_ID = "347btQbpUS2La9uhcLb2X";

  /* =====================================================
     COOKIE
     ===================================================== */

  const cookies =
    request.headers.get("Cookie") || "";

  function getCookie(name) {
    const match = cookies.match(
      new RegExp(
        "(^|;\\s*)" +
        name +
        "=([^;]*)"
      )
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

  /* =====================================================
     GET OPTIONS ACCOUNTS
     ===================================================== */

  async function getAccounts() {
    const response = await fetch(
      `${DERIV_API}/trading/v1/options/accounts`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Deriv-App-ID":
            CLIENT_ID,

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
    const result = [];

    function scan(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
        return;
      }

      if (
        typeof value !== "object"
      ) {
        return;
      }

      if (
        value.account_id ||
        value.loginid ||
        value.id
      ) {
        result.push(value);
      }

      for (
        const item of Object.values(value)
      ) {
        if (
          item &&
          typeof item === "object"
        ) {
          scan(item);
        }
      }
    }

    scan(data);

    const seen =
      new Set();

    return result.filter(account => {
      const id =
        account.account_id ||
        account.loginid ||
        account.id;

      if (!id) {
        return false;
      }

      const key =
        String(id);

      if (
        seen.has(key)
      ) {
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

  /* =====================================================
     FIND DEMO ACCOUNT
     ===================================================== */

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
        loginid.startsWith("vrt") ||
        loginid.startsWith("dot")
      );
    });
  }

  /* =====================================================
     CREATE AUTHENTICATED WEBSOCKET
     ===================================================== */

  async function createTradingSocket(account) {
    const accountId =
      getAccountId(account);

    if (!accountId) {
      throw new Error(
        "Deriv account ID is missing."
      );
    }

    const response =
      await fetch(
        `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(
          accountId
        )}/otp`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Deriv-App-ID":
              CLIENT_ID,

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
        "Unable to obtain Deriv trading OTP."
      );
    }

    const wsUrl =
      data.data?.url;

    if (!wsUrl) {
      throw new Error(
        "Deriv did not return a trading WebSocket URL."
      );
    }

    const ws =
      new WebSocket(wsUrl);

    await new Promise(
      (resolve, reject) => {
        let done = false;

        const timer =
          setTimeout(() => {
            if (done) return;

            done = true;

            reject(
              new Error(
                "Authenticated Deriv WebSocket connection timed out."
              )
            );
          }, 15000);

        ws.addEventListener(
          "open",
          () => {
            if (done) return;

            done = true;

            clearTimeout(timer);

            resolve();
          },
          { once: true }
        );

        ws.addEventListener(
          "error",
          () => {
            if (done) return;

            done = true;

            clearTimeout(timer);

            reject(
              new Error(
                "Authenticated Deriv WebSocket connection failed."
              )
            );
          },
          { once: true }
        );
      }
    );

    return ws;
  }

  /* =====================================================
     WEBSOCKET REQUEST
     ===================================================== */

  function wsRequest(
    ws,
    payload,
    expectedType,
    timeoutMs = 15000
  ) {
    return new Promise(
      (resolve, reject) => {

        let finished = false;

        const timer =
          setTimeout(() => {
            if (finished) return;

            finished = true;

            reject(
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

          clearTimeout(timer);

          callback(value);
        }

        function onMessage(event) {
          try {
            const data =
              typeof event.data === "string"
                ? JSON.parse(event.data)
                : event.data;

            console.log(
              "DollarTicks Deriv response:",
              JSON.stringify(data)
            );

            if (data.error) {
              ws.removeEventListener(
                "message",
                onMessage
              );

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
              expectedType
            ) {
              ws.removeEventListener(
                "message",
                onMessage
              );

              finish(
                resolve,
                data
              );
            }

          } catch (error) {
            ws.removeEventListener(
              "message",
              onMessage
            );

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
      }
    );
  }

  /* =====================================================
     VALID MARKETS
     ===================================================== */

  const VALID_MARKETS = [
    "1HZ10V",
    "1HZ25V",
    "1HZ50V",
    "1HZ75V",
    "1HZ100V"
  ];

  /* =====================================================
     VALID DIGIT CONTRACTS
     ===================================================== */

  const DIGIT_CONTRACTS = [
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITDIFF",
    "DIGITEVEN",
    "DIGITODD"
  ];

  /* =====================================================
     GET
     ===================================================== */

  try {

    if (
      request.method === "GET"
    ) {

      const accountData =
        await getAccounts();

      const accounts =
        extractAccounts(
          accountData
        );

      const demo =
        findDemo(accounts);

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

      return json({
        ok: true,

        connected: true,

        selected_account:
          demo
            ? {
                account_id:
                  getAccountId(
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
                getAccountId(
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

    /* ===================================================
       MARKET
       =================================================== */

    const market =
      String(
        body.market ||
        body.symbol ||
        body.underlying_symbol ||
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
      !VALID_MARKETS.includes(
        market
      )
    ) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            `Invalid market: ${market}`,

          valid_markets:
            VALID_MARKETS
        },
        400
      );
    }

    /* ===================================================
       ACCOUNT
       =================================================== */

    const accountData =
      await getAccounts();

    const accounts =
      extractAccounts(
        accountData
      );

    const account =
      findDemo(accounts);

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

    /* ===================================================
       PROPOSAL
       =================================================== */

    if (
      body.action ===
      "proposal"
    ) {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        )
        .trim()
        .toUpperCase();

      if (
        !DIGIT_CONTRACTS.includes(
          contractType
        )
      ) {
        return json(
          {
            ok: false,
            connected: true,

            error:
              `Invalid digit contract: ${contractType}`,

            valid_contracts:
              DIGIT_CONTRACTS
          },
          400
        );
      }

      const stake =
        Number(
          body.stake
        );

      const duration =
        Number(
          body.duration
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

      /* -----------------------------------------------
         DIGIT BARRIER
         ----------------------------------------------- */

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
        return json(
          {
            ok: false,
            error:
              "Digit barrier must be 0 to 9."
          },
          400
        );
      }

      /* -----------------------------------------------
         CONNECT
         ----------------------------------------------- */

      const ws =
        await createTradingSocket(
          account
        );

      try {

        /*
         * This is the official proposal structure:
         *
         * proposal
         * amount
         * basis
         * contract_type
         * currency
         * duration
         * duration_unit
         * underlying_symbol
         * barrier
         * subscribe
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
            "t",

          underlying_symbol:
            market,

          barrier:
            barrier,

          subscribe:
            1,

          req_id:
            Date.now()
        };

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
          !result.proposal
        ) {
          throw new Error(
            "Deriv returned a proposal response without proposal data."
          );
        }

        if (
          !result.proposal.id
        ) {
          throw new Error(
            "Deriv returned an invalid proposal ID."
          );
        }

        return json({
          ok: true,

          connected: true,

          market:
            market,

          contract_type:
            contractType,

          barrier:
            barrier,

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

    /* ===================================================
       BUY
       =================================================== */

    if (
      body.action ===
      "buy"
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
            error:
              "Invalid proposal price."
          },
          400
        );
      }

      const ws =
        await createTradingSocket(
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

          purchased:
            true,

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

    /* ===================================================
       UNKNOWN ACTION
       =================================================== */

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
          "Unable to communicate with Deriv.",

        details:
          String(error)
      },
      500
    );
  }
}
