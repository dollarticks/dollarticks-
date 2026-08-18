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


  const clientId =
    "347btQbpUS2La9uhcLb2X";

  const DERIV_API =
    "https://api.derivws.com";


  /*
   * =====================================================
   * GET ACCOUNTS
   * =====================================================
   */

  async function getAccounts() {

    const response =
      await fetch(
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
   * FIND ACCOUNTS
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


      if (
        typeof value !==
        "object"
      ) {
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
        const key of Object.keys(value)
      ) {

        if (
          value[key] &&
          typeof value[key] ===
          "object"
        ) {

          scan(value[key]);

        }

      }

    }


    scan(data);


    const unique = [];

    const seen =
      new Set();


    for (
      const account of found
    ) {

      const id =
        account.account_id ||
        account.loginid ||
        account.id;


      if (!id) continue;


      const key =
        String(id);


      if (!seen.has(key)) {

        seen.add(key);

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
      account.account_id ||
      account.loginid ||
      account.id ||
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
    requestedType,
    requestedId
  ) {


    if (requestedId) {

      const exact =
        accounts.find(
          account =>
            String(
              getAccountId(account)
            ) ===
            String(requestedId)
        );


      if (exact) {
        return exact;
      }

    }


    const type =
      String(
        requestedType ||
        "demo"
      ).toLowerCase();


    /*
     * DEMO ACCOUNT
     */

    if (type === "demo") {

      const demo =
        accounts.find(
          account => {

            const accountType =
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
              accountType === "demo" ||
              loginid.startsWith("vrt")
            );

          }
        );


      if (demo) {
        return demo;
      }

    }


    /*
     * REAL ACCOUNT
     */

    if (type === "real") {

      const real =
        accounts.find(
          account => {

            const accountType =
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
              accountType === "real" ||
              (
                loginid &&
                !loginid.startsWith("vrt")
              )
            );

          }
        );


      if (real) {
        return real;
      }

    }


    return null;

  }


  /*
   * =====================================================
   * AUTHENTICATED WEBSOCKET
   * =====================================================
   */

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

        let finished =
          false;


        const timeout =
          setTimeout(
            () => {

              if (finished) {
                return;
              }


              finished = true;


              reject(
                new Error(
                  "Deriv WebSocket request timed out."
                )
              );

            },
            timeoutMs
          );


        function finish(
          callback,
          value
        ) {

          if (finished) {
            return;
          }


          finished = true;


          clearTimeout(
            timeout
          );


          callback(value);

        }


        ws.addEventListener(
          "message",
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

          },
          {
            once: true
          }
        );


        function send() {

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

        }


        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {

          send();

        } else {

          ws.addEventListener(
            "open",
            send,
            {
              once: true
            }
          );

        }

      }
    );

  }


  /*
   * =====================================================
   * NORMALIZE MARKET
   *
   * This accepts:
   *
   * 1HZ100V
   * 1HZ75V
   * 1HZ50V
   * 1HZ25V
   * 1HZ10V
   * =====================================================
   */

  function normalizeMarket(
    body
  ) {

    const possibleMarket =
      body.market ||
      body.symbol ||
      body.underlying_symbol ||
      body.underlying ||
      null;


    if (
      possibleMarket === null ||
      possibleMarket === undefined
    ) {

      return null;

    }


    const market =
      String(
        possibleMarket
      ).trim();


    if (!market) {
      return null;
    }


    const allowedMarkets = [

      "1HZ100V",
      "1HZ75V",
      "1HZ50V",
      "1HZ25V",
      "1HZ10V"

    ];


    if (
      !allowedMarkets.includes(
        market
      )
    ) {

      throw new Error(
        `Invalid market "${market}". Use 1HZ100V, 1HZ75V, 1HZ50V, 1HZ25V or 1HZ10V.`
      );

    }


    return market;

  }


  /*
   * =====================================================
   * CREATE PROPOSAL
   * =====================================================
   */

  function createProposalRequest(
    body,
    currency
  ) {


    const market =
      normalizeMarket(body);


    if (!market) {

      throw new Error(
        "Market is required. Select a Volatility market first."
      );

    }


    const contractType =
      String(
        body.contract_type ||
        ""
      ).toUpperCase();


    if (!contractType) {

      throw new Error(
        "Contract type is required."
      );

    }


    const stake =
      Number(
        body.stake
      );


    if (
      !Number.isFinite(stake) ||
      stake <= 0
    ) {

      throw new Error(
        "Enter a valid stake."
      );

    }


    const duration =
      Number(
        body.duration
      );


    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {

      throw new Error(
        "Enter a valid duration."
      );

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
        currency ||
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

      requestData.barrier =
        String(
          body.barrier ??
          5
        );

    }


    return requestData;

  }


  /*
   * =====================================================
   * MAIN
   * =====================================================
   */

  try {


    /*
     * ===================================================
     * GET
     * ===================================================
     */

    if (
      request.method ===
      "GET"
    ) {

      const data =
        await getAccounts();


      const accounts =
        extractAccounts(data);


      if (!accounts.length) {

        return json({

          ok: false,

          connected: true,

          error:
            "Deriv login succeeded, but no Options account was returned.",

          deriv_response:
            data

        });

      }


      const formatted =
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
              "active",

            balance:
              account.balance ??
              null

          })
        );


      const demo =
        findAccount(
          accounts,
          "demo"
        );


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
            ? "Deriv demo account found."
            : "Deriv is connected, but no demo account was found."

      });

    }


    /*
     * ===================================================
     * POST ONLY
     * ===================================================
     */

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


    /*
     * ===================================================
     * ACCOUNT TYPE
     * ===================================================
     */

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


    /*
     * ===================================================
     * ACCOUNT
     * ===================================================
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
      findAccount(
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

        },
        404
      );

    }


    const accountId =
      getAccountId(
        account
      );


    if (!accountId) {

      return json(
        {
          ok: false,

          connected: true,

          error:
            "Deriv account was found but has no account ID."

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
     * ===================================================
     * ACCOUNT INFORMATION
     * ===================================================
     */

    if (
      body.action ===
      "account"
    ) {

      return json({

        ok: true,

        connected: true,

        account: {

          account_id:
            accountId,

          loginid:
            account.loginid ||
            null,

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
     * GET PROPOSAL
     * ===================================================
     */

    if (
      body.action ===
      "proposal"
    ) {


      const proposalRequest =
        createProposalRequest(
          body,
          account.currency
        );


      const ws =
        await createAuthenticatedWS(
          accountId
        );


      try {


        const result =
          await wsRequest(
            ws,
            proposalRequest,
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

            account_id:
              accountId,

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
              null

          },

          message:
            "Fresh proposal received. No contract was purchased."

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
     *
     * IMPORTANT:
     *
     * We deliberately IGNORE any old proposal ID.
     *
     * A fresh proposal is requested and immediately
     * purchased on the SAME WebSocket.
     * ===================================================
     */

    if (
      body.action ===
      "buy"
    ) {


      /*
       * REAL ACCOUNT SAFETY
       */

      if (
        isReal &&
        body.confirm_real !== true
      ) {

        return json(
          {

            ok: false,

            connected: true,

            real_account:
              true,

            requires_confirmation:
              true,

            error:
              "Real account selected. Explicit confirmation is required before purchasing."

          },
          400
        );

      }


      /*
       * Build fresh proposal.
       */

      const proposalRequest =
        createProposalRequest(
          body,
          account.currency
        );


      /*
       * Authenticated WebSocket.
       */

      const ws =
        await createAuthenticatedWS(
          accountId
        );


      try {


        /*
         * ================================================
         * STEP 1
         * FRESH PROPOSAL
         * ================================================
         */

        const proposalResult =
          await wsRequest(
            ws,
            proposalRequest,
            "proposal"
          );


        const proposal =
          proposalResult.proposal;


        if (!proposal?.id) {

          throw new Error(
            "Deriv did not return a fresh proposal ID."
          );

        }


        const freshProposalId =
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
         * ================================================
         * STEP 2
         * IMMEDIATELY BUY FRESH PROPOSAL
         * ================================================
         */

        const buyRequest = {

          buy:
            freshProposalId,

          price:
            askPrice,

          req_id:
            Date.now() + 1

        };


        const buyResult =
          await wsRequest(
            ws,
            buyRequest,
            "buy",
            15000
          );


        const buy =
          buyResult.buy;


        if (!buy) {

          throw new Error(
            "Deriv did not return a purchase result."
          );

        }


        /*
         * ================================================
         * SUCCESS
         * ================================================
         */

        return json({

          ok: true,

          connected: true,

          purchased:
            true,

          real_account:
            isReal,

          account: {

            account_id:
              accountId,

            account_type:
              account.account_type ||
              requestedType,

            currency:
              account.currency ||
              "USD"

          },

          proposal: {

            id:
              freshProposalId,

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
