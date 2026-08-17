export async function onRequest(context) {
  const request = context.request;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json"
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
          "Deriv session expired. Please connect your Deriv account again."
      },
      401
    );
  }

  const clientId =
    "347btQbpUS2La9uhcLb2X";

  try {
    /*
     * GET
     * Check the authenticated Deriv Options account.
     */

    if (request.method === "GET") {

      const accountsResponse =
        await fetch(
          "https://api.derivws.com/trading/v1/options/accounts",
          {
            method: "GET",
            headers: {
              "Authorization":
                `Bearer ${accessToken}`,
              "Deriv-App-ID":
                clientId
            }
          }
        );

      const accountsData =
        await accountsResponse.json();

      if (!accountsResponse.ok) {
        return json(
          {
            ok: false,
            connected: true,
            stage:
              "authenticated-account-request",
            deriv_response:
              accountsData
          },
          accountsResponse.status
        );
      }

      let accounts = [];

      if (Array.isArray(accountsData.data)) {
        accounts = accountsData.data;
      }

      if (
        Array.isArray(
          accountsData.data?.accounts
        )
      ) {
        accounts =
          accountsData.data.accounts;
      }

      if (
        Array.isArray(
          accountsData.accounts
        )
      ) {
        accounts =
          accountsData.accounts;
      }

      if (
        !accounts.length &&
        accountsData.data &&
        typeof accountsData.data === "object" &&
        !Array.isArray(accountsData.data)
      ) {
        if (
          accountsData.data.account_id ||
          accountsData.data.id ||
          accountsData.data.loginid
        ) {
          accounts = [
            accountsData.data
          ];
        }
      }

      if (!accounts.length) {
        return json({
          ok: false,
          connected: true,
          stage:
            "account-discovery",
          message:
            "Deriv authentication works, but no Options account was found.",
          deriv_response:
            accountsData
        });
      }

      const account =
        accounts.find(
          a =>
            a.account_type === "demo" &&
            a.status === "active"
        ) || accounts[0];

      const accountId =
        account.account_id ||
        account.id ||
        account.loginid;

      if (!accountId) {
        return json({
          ok: false,
          connected: true,
          stage:
            "account-id",
          message:
            "An Options account was returned, but no account ID was found.",
          account
        });
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
            "USD",
          status:
            account.status ||
            null
        },
        message:
          "Deriv Options account is connected."
      });
    }

    /*
     * Only POST is used for trading requests.
     */

    if (request.method !== "POST") {
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
     * Get authenticated Options account.
     */

    const accountsResponse =
      await fetch(
        "https://api.derivws.com/trading/v1/options/accounts",
        {
          method: "GET",
          headers: {
            "Authorization":
              `Bearer ${accessToken}`,
            "Deriv-App-ID":
              clientId
          }
        }
      );

    const accountsData =
      await accountsResponse.json();

    if (!accountsResponse.ok) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "Could not access the Deriv Options account.",
          deriv_response:
            accountsData
        },
        accountsResponse.status
      );
    }

    let accounts = [];

    if (Array.isArray(accountsData.data)) {
      accounts =
        accountsData.data;
    }

    if (
      Array.isArray(
        accountsData.data?.accounts
      )
    ) {
      accounts =
        accountsData.data.accounts;
    }

    if (
      Array.isArray(
        accountsData.accounts
      )
    ) {
      accounts =
        accountsData.accounts;
    }

    if (
      !accounts.length &&
      accountsData.data &&
      typeof accountsData.data === "object" &&
      !Array.isArray(accountsData.data)
    ) {
      if (
        accountsData.data.account_id ||
        accountsData.data.id ||
        accountsData.data.loginid
      ) {
        accounts = [
          accountsData.data
        ];
      }
    }

    if (!accounts.length) {
      return json({
        ok: false,
        connected: true,
        error:
          "No Deriv Options trading account was found."
      });
    }

    const account =
      accounts.find(
        a =>
          a.account_type === "demo" &&
          a.status === "active"
      ) || accounts[0];

    const accountId =
      account.account_id ||
      account.id ||
      account.loginid;

    if (!accountId) {
      return json({
        ok: false,
        connected: true,
        error:
          "Deriv account ID was not returned."
      });
    }

    /*
     * Get the one-time authenticated
     * WebSocket URL.
     */

    const otpResponse =
      await fetch(
        `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
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

    const otpData =
      await otpResponse.json();

    if (
      !otpResponse.ok ||
      !otpData.data?.url
    ) {
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "otp",
          error:
            "Could not create the authenticated Deriv WebSocket.",
          deriv_response:
            otpData
        },
        otpResponse.status
      );
    }

    const wsUrl =
      otpData.data.url;

    /*
     * Make sure WebSocket exists.
     */

    if (
      typeof WebSocket ===
      "undefined"
    ) {
      return json(
        {
          ok: false,
          connected: true,
          error:
            "WebSocket is not available in this Cloudflare runtime."
        },
        500
      );
    }

    /*
     * Connect immediately because the
     * OTP is short-lived and single-use.
     */

    const ws =
      new WebSocket(wsUrl);

    const response =
      await new Promise(
        (resolve) => {

          let finished = false;

          const finish =
            (data, status = 200) => {

              if (finished)
                return;

              finished = true;

              try {
                ws.close();
              } catch {}

              resolve(
                json(data, status)
              );
            };

          const timeout =
            setTimeout(
              () => {

                finish(
                  {
                    ok: false,
                    connected: true,
                    error:
                      "Deriv WebSocket request timed out."
                  },
                  504
                );

              },
              15000
            );

          ws.addEventListener(
            "open",
            () => {

              /*
               * PROPOSAL
               */

              if (
                body.action ===
                "proposal"
              ) {

                const contractType =
                  body.contract_type;

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
                    Number(body.stake),
                  basis:
                    "stake",
                  contract_type:
                    contractType,
                  currency:
                    account.currency ||
                    "USD",
                  duration:
                    Number(body.duration) ||
                    1,
                  duration_unit:
                    body.duration_unit ||
                    "t",
                  underlying_symbol:
                    body.market,
                  req_id:
                    1001
                };

                if (
                  digitContracts.includes(
                    contractType
                  )
                ) {
                  proposalRequest.barrier =
                    String(body.barrier);
                }

                ws.send(
                  JSON.stringify(
                    proposalRequest
                  )
                );

                return;
              }

              /*
               * BUY
               *
               * We are intentionally keeping
               * purchase support separate.
               */

              if (
                body.action ===
                "buy"
              ) {

                if (
                  !body.proposal_id
                ) {

                  clearTimeout(
                    timeout
                  );

                  finish(
                    {
                      ok: false,
                      error:
                        "Missing proposal ID."
                    },
                    400
                  );

                  return;
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

                  clearTimeout(
                    timeout
                  );

                  finish(
                    {
                      ok: false,
                      error:
                        "Invalid purchase price."
                    },
                    400
                  );

                  return;
                }

                ws.send(
                  JSON.stringify({
                    buy:
                      String(
                        body.proposal_id
                      ),
                    price:
                      price,
                    req_id:
                      2001
                  })
                );

                return;
              }

              clearTimeout(
                timeout
              );

              finish(
                {
                  ok: false,
                  error:
                    "Unknown trading action."
                },
                400
              );

            }
          );

          ws.addEventListener(
            "message",
            event => {

              try {

                const data =
                  JSON.parse(
                    event.data
                  );

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
                        "Deriv rejected the request.",
                      deriv_error:
                        data.error
                    },
                    400
                  );

                  return;
                }

                /*
                 * Proposal response
                 */

                if (
                  body.action ===
                  "proposal" &&
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
                      "Real Deriv proposal received. No trade was purchased."
                  });

                  return;
                }

                /*
                 * Buy response
                 */

                if (
                  body.action ===
                  "buy" &&
                  data.msg_type ===
                  "buy"
                ) {

                  clearTimeout(
                    timeout
                  );

                  const buy =
                    data.buy || {};

                  finish({
                    ok: true,
                    connected: true,
                    purchased: true,
                    contract: {
                      contract_id:
                        buy.contract_id ||
                        null,
                      buy_price:
                        buy.buy_price ||
                        null,
                      payout:
                        buy.payout ||
                        null,
                      start_time:
                        buy.start_time ||
                        null,
                      longcode:
                        buy.longcode ||
                        null
                    },
                    message:
                      "Demo trade purchased successfully."
                  });

                  return;
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
                      "Invalid response from Deriv."
                  },
                  500
                );

              }
            }
          );

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

          ws.addEventListener(
            "close",
            () => {

              if (finished)
                return;

              clearTimeout(
                timeout
              );

              finish(
                {
                  ok: false,
                  connected: true,
                  error:
                    "Deriv WebSocket closed before a response was received."
                },
                502
              );

            }
          );

        }
      );

    return response;

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
