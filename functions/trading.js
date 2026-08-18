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

  /* =========================================
     COOKIE / ACCESS TOKEN
     ========================================= */

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

  /* =========================================
     DERIV CONFIG
     ========================================= */

  const clientId =
    "347btQbpUS2La9uhcLb2X";

  const DERIV_API =
    "https://api.derivws.com";


  /* =========================================
     GET OPTIONS ACCOUNTS
     ========================================= */

  async function getAccounts() {

    const response =
      await fetch(
        `${DERIV_API}/trading/v1/options/accounts`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Deriv-App-ID":
              clientId,

            Accept:
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    console.log(
      "DOLLARTICKS ACCOUNTS RESPONSE:",
      JSON.stringify(data)
    );

    if (!response.ok) {

      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        `Deriv account request failed (${response.status}).`
      );
    }

    return data;
  }


  /* =========================================
     EXTRACT ACCOUNTS
     ========================================= */

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

    return found.filter(account => {

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
    });
  }


  /* =========================================
     ACCOUNT ID
     ========================================= */

  function accountId(account) {

    return (
      account.account_id ||
      account.loginid ||
      account.id ||
      null
    );
  }


  /* =========================================
     FIND DEMO ACCOUNT
     ========================================= */

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
        loginid.startsWith("vrt")
      );
    });
  }


  /* =========================================
     CREATE AUTHENTICATED WEBSOCKET
     ========================================= */

  async function createWebSocket(account) {

    const id =
      accountId(account);

    if (!id) {

      throw new Error(
        "Deriv account ID is missing."
      );
    }

    console.log(
      "DOLLARTICKS REQUESTING OTP FOR:",
      id
    );

    const response =
      await fetch(
        `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(id)}/otp`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Deriv-App-ID":
              clientId,

            Accept:
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    console.log(
      "DOLLARTICKS OTP RESPONSE:",
      JSON.stringify(data)
    );

    if (!response.ok) {

      throw new Error(
        data.errors?.[0]?.message ||
        data.error?.message ||
        `OTP request failed with HTTP ${response.status}.`
      );
    }

    if (
      !data.data ||
      !data.data.url
    ) {

      throw new Error(
        "Deriv did not return an authenticated WebSocket URL."
      );
    }

    const wsUrl =
      data.data.url;

    console.log(
      "DOLLARTICKS: AUTHENTICATED WS URL RECEIVED"
    );

    /*
     * IMPORTANT:
     * Connect directly to the URL returned
     * by Deriv's OTP endpoint.
     */

    return new WebSocket(
      wsUrl
    );
  }


  /* =========================================
     WEBSOCKET REQUEST
     ========================================= */

  function wsRequest(
    ws,
    payload,
    expectedMessage
  ) {

    return new Promise(
      (resolve, reject) => {

        let finished =
          false;

        let opened =
          false;

        const timeout =
          setTimeout(() => {

            if (finished) {
              return;
            }

            finished =
              true;

            reject(
              new Error(
                `Deriv request timed out waiting for ${expectedMessage}.`
              )
            );

          }, 15000);


        function finish(
          callback,
          value
        ) {

          if (finished) {
            return;
          }

          finished =
            true;

          clearTimeout(
            timeout
          );

          callback(
            value
          );
        }


        /*
         * OPEN
         */

        ws.addEventListener(
          "open",
          () => {

            opened =
              true;

            console.log(
              "DOLLARTICKS: AUTHENTICATED WEBSOCKET OPEN"
            );

            try {

              ws.send(
                JSON.stringify(
                  payload
                )
              );

              console.log(
                "DOLLARTICKS SENT REQUEST:",
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

          },
          { once: true }
        );


        /*
         * MESSAGE
         */

        ws.addEventListener(
          "message",
          event => {

            try {

              const data =
                JSON.parse(
                  event.data
                );

              console.log(
                "DOLLARTICKS DERIV MESSAGE:",
                JSON.stringify(
                  data
                )
              );


              /*
               * DERIV ERROR
               */

              if (data.error) {

                const code =
                  data.error.code ||
                  "DERIV_ERROR";

                const message =
                  data.error.message ||
                  "Deriv rejected the request.";

                finish(
                  reject,
                  new Error(
                    `${code}: ${message}`
                  )
                );

                return;
              }


              /*
               * EXPECTED RESPONSE
               */

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


        /*
         * ERROR
         */

        ws.addEventListener(
          "error",
          event => {

            console.error(
              "DOLLARTICKS WEBSOCKET ERROR:",
              event
            );

            if (!opened) {

              finish(
                reject,
                new Error(
                  "Deriv authenticated WebSocket failed before opening."
                )
              );

            } else {

              finish(
                reject,
                new Error(
                  "Deriv authenticated WebSocket encountered a connection error."
                )
              );
            }

          }
        );


        /*
         * CLOSE
         */

        ws.addEventListener(
          "close",
          event => {

            console.error(
              "DOLLARTICKS WEBSOCKET CLOSED:",
              {
                code:
                  event.code,

                reason:
                  event.reason,

                wasClean:
                  event.wasClean
              }
            );


            if (finished) {
              return;
            }


            let message =
              "Deriv authenticated WebSocket closed.";


            if (event.code) {

              message +=
                ` Close code: ${event.code}.`;
            }


            if (event.reason) {

              message +=
                ` Reason: ${event.reason}.`;
            }


            if (!opened) {

              message +=
                " The connection closed before it opened.";
            }


            finish(
              reject,
              new Error(
                message
              )
            );

          }
        );

      }
    );
  }


  /* =========================================
     MAIN REQUEST HANDLER
     ========================================= */

  try {


    /* =======================================
       GET
       ======================================= */

    if (
      request.method ===
      "GET"
    ) {

      const data =
        await getAccounts();

      const accounts =
        extractAccounts(
          data
        );

      if (
        !accounts.length
      ) {

        return json({
          ok: false,

          connected: true,

          error:
            "No Deriv Options account was returned.",

          deriv_response:
            data
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


    /* =======================================
       ONLY GET AND POST ALLOWED
       ======================================= */

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


    /* =======================================
       READ BODY
       ======================================= */

    const body =
      await request.json();


    console.log(
      "DOLLARTICKS POST BODY:",
      JSON.stringify(
        body
      )
    );


    /* =======================================
       MARKET
       ======================================= */

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
            "Market is required. Select a Volatility market first.",

          received_body:
            body
        },
        400
      );
    }


    const validMarkets = [

      "1HZ100V",

      "1HZ75V",

      "1HZ50V",

      "1HZ25V",

      "1HZ10V"

    ];


    if (
      !validMarkets.includes(
        market
      )
    ) {

      return json(
        {
          ok: false,

          connected: true,

          error:
            `Invalid market: ${market}.`,

          received_market:
            market,

          valid_markets:
            validMarkets
        },
        400
      );
    }


    /* =======================================
       ACCOUNT
       ======================================= */

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
            "No demo Deriv Options account was found.",

          accounts:
            accounts.map(
              a => ({

                account_id:
                  accountId(a),

                loginid:
                  a.loginid ||
                  null,

                account_type:
                  a.account_type ||
                  null,

                currency:
                  a.currency ||
                  "USD"

              })
            )
        },
        404
      );
    }


    const id =
      accountId(
        account
      );


    /* =======================================
       PROPOSAL
       ======================================= */

    if (
      body.action ===
      "proposal"
    ) {

      const contractType =
        String(
          body.contract_type ||
          "DIGITOVER"
        ).toUpperCase().trim();


      const allowedContracts = [

        "DIGITOVER",

        "DIGITUNDER",

        "DIGITMATCH",

        "DIGITDIFF",

        "DIGITEVEN",

        "DIGITODD"

      ];


      if (
        !allowedContracts.includes(
          contractType
        )
      ) {

        return json(
          {
            ok: false,

            connected: true,

            error:
              `Invalid contract type: ${contractType}`,

            allowed_contracts:
              allowedContracts
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


      /*
       * DIGIT CONTRACT BARRIER
       */

      const digitContracts = [

        "DIGITOVER",

        "DIGITUNDER",

        "DIGITMATCH",

        "DIGITDIFF"

      ];


      let barrier =
        String(
          body.barrier ??
          "5"
        ).trim();


      if (
        digitContracts.includes(
          contractType
        )
      ) {

        if (
          !/^[0-9]$/.test(
            barrier
          )
        ) {

          return json(
            {
              ok: false,

              error:
                "Digit barrier must be from 0 to 9."
            },
            400
          );
        }
      }


      /* =====================================
         OPEN AUTHENTICATED WS
         ===================================== */

      const ws =
        await createWebSocket(
          account
        );


      try {


        /*
         * PROPOSAL REQUEST
         */

        const proposalRequest = {

          proposal:
            1,

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

          req_id:
            Date.now()

        };


        /*
         * ADD BARRIER ONLY WHERE REQUIRED
         */

        if (
          digitContracts.includes(
            contractType
          )
        ) {

          proposalRequest.barrier =
            barrier;
        }


        console.log(
          "DOLLARTICKS PROPOSAL REQUEST:",
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


        /*
         * VALIDATE RESPONSE
         */

        if (
          !result.proposal ||
          !result.proposal.id
        ) {

          return json(
            {
              ok: false,

              connected: true,

              error:
                "Deriv returned a proposal without a proposal ID.",

              deriv_response:
                result
            },
            502
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
            digitContracts.includes(
              contractType
            )
              ? barrier
              : null,


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
            "Fresh Deriv proposal received."

        });


      } finally {

        try {
          ws.close();
        } catch {}

      }

    }


    /* =======================================
       BUY
       ======================================= */

    if (
      body.action ===
      "buy"
    ) {


      if (
        !body.proposal_id
      ) {

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

            connected: true,

            error:
              "Invalid proposal price."
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

          req_id:
            Date.now()

        };


        console.log(
          "DOLLARTICKS BUY REQUEST:",
          JSON.stringify(
            buyRequest
          )
        );


        const result =
          await wsRequest(
            ws,

            buyRequest,

            "buy"
          );


        if (
          !result.buy
        ) {

          return json(
            {
              ok: false,

              connected: true,

              error:
                "Deriv returned no buy result.",

              deriv_response:
                result
            },
            502
          );
        }


        return json({

          ok: true,

          connected: true,

          purchased: true,


          account: {

            account_id:
              id,

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
              null,

            purchase_time:
              result.buy.purchase_time ??
              null,

            start_time:
              result.buy.start_time ??
              null,

            longcode:
              result.buy.longcode ??
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


    /* =======================================
       UNKNOWN ACTION
       ======================================= */

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
      "DOLLARTICKS TRADING ERROR:",
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
