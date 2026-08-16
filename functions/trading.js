export async function onRequest(context) {
  const request = context.request;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    });

  if (request.method === "GET") {
    const cookies =
      request.headers.get("Cookie") || "";

    const hasSession =
      /(?:^|;\s*)dt_access_token=/.test(cookies);

    return json({
      ok: hasSession,
      connected: hasSession,
      message: hasSession
        ? "DollarTicks session detected."
        : "No Deriv session detected."
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

  try {
    const body = await request.json();

    if (body.action !== "proposal") {
      return json(
        {
          ok: false,
          error: "Only proposal requests are enabled."
        },
        400
      );
    }

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
          error:
            "Deriv session expired. Please connect your Deriv account again."
        },
        401
      );
    }

    const clientId =
      "347btQbpUS2La9uhcLb2X";

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
      console.error(
        "Accounts error:",
        accountsData
      );

      return json(
        {
          ok: false,
          error:
            "Could not access the Deriv trading account.",
          details:
            accountsData?.error?.message ||
            accountsData?.message ||
            null
        },
        401
      );
    }

    const accounts =
      accountsData.data?.accounts ||
      accountsData.accounts ||
      [];

    if (!accounts.length) {
      return json(
        {
          ok: false,
          error:
            "No Deriv Options trading account was found."
        },
        400
      );
    }

    const account =
      accounts[0];

    const accountId =
      account.account_id ||
      account.id ||
      account.loginid;

    if (!accountId) {
      console.error(
        "Account response:",
        accountsData
      );

      return json(
        {
          ok: false,
          error:
            "Deriv account ID was not returned."
        },
        400
      );
    }

    const otpResponse =
      await fetch(
        `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${accessToken}`,
            "Deriv-App-ID":
              clientId
          }
        }
      );

    const otpData =
      await otpResponse.json();

    if (
      !otpResponse.ok ||
      !otpData.data?.url
    ) {
      console.error(
        "OTP error:",
        otpData
      );

      return json(
        {
          ok: false,
          error:
            "Could not create the authenticated Deriv connection."
        },
        401
      );
    }

    const ws =
      new WebSocket(
        otpData.data.url
      );

    const proposal =
      await new Promise(
        (resolve, reject) => {
          let finished = false;

          const timeout =
            setTimeout(() => {
              if (finished) return;

              finished = true;

              try {
                ws.close();
              } catch {}

              reject(
                new Error(
                  "Deriv proposal request timed out."
                )
              );
            }, 15000);

          ws.addEventListener(
            "open",
            () => {
              const contractType =
                body.contract_type;

              const digitTypes = [
                "DIGITOVER",
                "DIGITUNDER",
                "DIGITMATCH",
                "DIGITDIFF",
                "DIGITEVEN",
                "DIGITODD"
              ];

              const payload = {
                proposal: 1,
                amount:
                  Number(body.stake),
                basis: "stake",
                contract_type:
                  contractType,
                currency:
                  "USD",
                duration:
                  Number(body.duration) || 1,
                duration_unit:
                  body.duration_unit || "t",
                underlying_symbol:
                  body.market,
                req_id:
                  1001
              };

              if (
                digitTypes.includes(
                  contractType
                )
              ) {
                payload.barrier =
                  String(body.barrier);
              }

              try {
                ws.send(
                  JSON.stringify(
                    payload
                  )
                );
              } catch (error) {
                if (finished) return;

                finished = true;
                clearTimeout(timeout);
                reject(error);
              }
            }
          );

          ws.addEventListener(
            "message",
            event => {
              if (finished) return;

              try {
                const data =
                  JSON.parse(
                    event.data
                  );

                if (data.error) {
                  finished = true;
                  clearTimeout(
                    timeout
                  );

                  try {
                    ws.close();
                  } catch {}

                  reject(
                    new Error(
                      data.error.message ||
                      "Deriv rejected the proposal."
                    )
                  );

                  return;
                }

                if (
                  data.msg_type ===
                  "proposal"
                ) {
                  finished = true;
                  clearTimeout(
                    timeout
                  );

                  try {
                    ws.close();
                  } catch {}

                  resolve(
                    data.proposal
                  );
                }
              } catch (error) {
                if (finished) return;

                finished = true;
                clearTimeout(
                  timeout
                );

                try {
                  ws.close();
                } catch {}

                reject(error);
              }
            }
          );

          ws.addEventListener(
            "error",
            () => {
              if (finished) return;

              finished = true;
              clearTimeout(timeout);

              reject(
                new Error(
                  "Authenticated Deriv WebSocket connection failed."
                )
              );
            }
          );
        }
      );

    return json({
      ok: true,
      proposal: {
        id:
          proposal.id,
        ask_price:
          proposal.ask_price,
        payout:
          proposal.payout,
        spot:
          proposal.spot
      },
      message:
        "Real Deriv proposal received. No trade was purchased."
    });

  } catch (error) {
    console.error(
      "Trading proposal error:",
      error
    );

    return json(
      {
        ok: false,
        error:
          error.message ||
          "Unable to get Deriv proposal."
      },
      500
    );
  }
            }
