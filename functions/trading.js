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

  /*
   * Find an account anywhere inside Deriv's response.
   */
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

      if (typeof value !== "object") return;

      /*
       * Account object
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

    /*
     * Remove duplicates.
     */
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

  /*
   * Get Deriv Options accounts.
   */
  async function getAccounts() {
    const response = await fetch(
      "https://api.derivws.com/trading/v1/options/accounts",
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

  try {

    /*
     * =====================================================
     * GET /trading
     * Check connection
     * =====================================================
     */

    if (request.method === "GET") {

      const result = await getAccounts();

      /*
       * Authentication itself worked.
       */
      if (!result.response.ok) {
        return json(
          {
            ok: false,
            connected: false,
            stage: "deriv-account-request",
            error: "Deriv rejected the account request.",
            deriv_response: result.data
          },
          result.response.status
        );
      }

      if (!result.accounts.length) {
        return json({
          ok: false,
          connected: true,
          stage: "account-discovery",
          error: "Deriv login succeeded, but no Options account was returned.",
          deriv_response: result.data
        });
      }

      /*
       * Prefer an active demo account.
       */
      const account =
        result.accounts.find(
          a =>
            String(a.account_type).toLowerCase() === "demo" &&
            String(a.status).toLowerCase() === "active"
        ) ||
        result.accounts.find(
          a =>
            String(a.status).toLowerCase() === "active"
        ) ||
        result.accounts[0];

      const accountId =
        account.account_id ||
        account.loginid ||
        account.id;

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
            account.status || "active"
        },

        accounts_found:
          result.accounts.length,

        message:
          "Deriv Options account is connected."
      });
    }


    /*
     * =====================================================
     * ONLY POST BELOW THIS POINT
     * =====================================================
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


    /*
     * =====================================================
     * GET AUTHENTICATED ACCOUNT
     * =====================================================
     */

    const result = await getAccounts();

    if (!result.response.ok) {
      return json(
        {
          ok: false,
          connected: false,
          error: "Could not access the Deriv account.",
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
          "Deriv login is working, but Deriv did not return an Options account.",
        deriv_response: result.data
      });
    }


    /*
     * Prefer active demo account.
     */

    const account =
      result.accounts.find(
        a =>
          String(a.account_type).toLowerCase() === "demo" &&
          String(a.status).toLowerCase() === "active"
      ) ||
      result.accounts.find(
        a =>
          String(a.status).toLowerCase() === "active"
      ) ||
      result.accounts[0];


    const accountId =
      account.account_id ||
      account.loginid ||
      account.id;


    if (!accountId) {
      return json({
        ok: false,
        connected: true,
        error:
          "Deriv returned an account, but no account ID was found.",
        account
      });
    }


    /*
     * =====================================================
     * PROPOSAL
     * =====================================================
     */

    if (body.action === "proposal") {

      const otpResponse = await fetch(
        `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
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
        !otpData.data?.url
      ) {
        return json(
          {
            ok: false,
            connected: true,
            stage: "otp",
            error:
              "Could not create the authenticated Deriv WebSocket.",
            deriv_response: otpData
          },
          otpResponse.status || 502
        );
      }


      /*
       * Open authenticated WebSocket.
       */

      const ws = new WebSocket(
        otpData.data.url
      );


      return await new Promise(resolve => {

        let finished = false;

        const finish = (data, status = 200) => {

          if (finished) return;

          finished = true;

          try {
            ws.close();
          } catch {}

          resolve(
            json(data, status)
          );
        };


        const timeout = setTimeout(() => {

          finish(
            {
              ok: false,
              connected: true,
              error:
                "Deriv WebSocket request timed out."
            },
            504
          );

        }, 15000);


        /*
         * WEBSOCKET OPEN
         */

        ws.addEventListener(
          "open",
          () => {

            const contractType =
              String(
                body.contract_type || ""
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
                Number(body.stake) || 1,

              basis:
                "stake",

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

              req_id:
                1001

            };


            /*
             * Digit contracts require a barrier.
             */

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


            ws.send(
              JSON.stringify(
                proposalRequest
              )
            );

          }
        );


        /*
         * WEBSOCKET MESSAGE
         */

        ws.addEventListener(
          "message",
          event => {

            try {

              const data =
                JSON.parse(
                  event.data
                );


              /*
               * Deriv error
               */

              if (data.error) {

                clearTimeout(
                  timeout
                );

                finish(
                  {
                    ok: false,
                    connected: true,
                    error:
                      data.error.message ||
                      "Deriv rejected the proposal.",
                    deriv_error:
                      data.error
                  },
                  400
                );

                return;
              }


              /*
               * Proposal received
               */

              if (
                data.msg_type ===
                "proposal"
              ) {

                clearTimeout(
                  timeout
                );

                const proposal =
                  data.proposal || {};


                finish({
                  ok: true,
                  connected: true,

                  proposal: {
                    id:
                      proposal.id ||
                      null,

                    ask_price:
                      proposal.ask_price ||
                      null,

                    payout:
                      proposal.payout ||
                      null,

                    spot:
                      proposal.spot ||
                      null
                  },

                  message:
                    "Real Deriv proposal received. No contract was purchased."
                });

              }

            } catch (error) {

              clearTimeout(
                timeout
              );

              finish(
                {
                  ok: false,
                  connected: true,
                  error:
                    error.message ||
                    "Invalid Deriv response."
                },
                500
              );

            }

          }
        );


        /*
         * WEBSOCKET ERROR
         */

        ws.addEventListener(
          "error",
          () => {

            clearTimeout(
              timeout
            );

            finish(
              {
                ok: false,
                connected: true,
                error:
                  "Authenticated Deriv WebSocket connection failed."
              },
              502
            );

          }
        );


        /*
         * WEBSOCKET CLOSE
         */

        ws.addEventListener(
          "close",
          () => {

            if (finished) return;

            clearTimeout(
              timeout
            );

            finish(
              {
                ok: false,
                connected: true,
                error:
                  "Deriv WebSocket closed before returning a proposal."
              },
              502
            );

          }
        );

      });
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
