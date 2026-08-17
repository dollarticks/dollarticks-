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

  /*
   * First test the authenticated
   * Deriv Options account endpoint.
   */

  try {
    const accountsResponse =
      await fetch(
        "https://api.derivws.com/trading/v1/options/accounts",
        {
          method: "GET",
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

    const accountsData =
      await accountsResponse.json();

    /*
     * IMPORTANT:
     * We never return the access token.
     * Only the safe account response is returned.
     */

    if (!accountsResponse.ok) {
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "authenticated-account-request",
          http_status:
            accountsResponse.status,
          deriv_response:
            accountsData
        },
        accountsResponse.status
      );
    }

    /*
     * Deriv normally returns the accounts
     * inside data.
     */

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

    /*
     * If no account was found, return the
     * actual safe response so we can see
     * what Deriv is sending us.
     */

    if (!accounts.length) {
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "account-discovery",
          message:
            "Deriv authentication works, but no Options account was found in the response.",
          deriv_response:
            accountsData
        },
        200
      );
    }

    const account =
      accounts[0];

    const accountId =
      account.account_id ||
      account.id ||
      account.loginid;

    if (!accountId) {
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "account-id",
          message:
            "An account was returned, but no account ID was found.",
          account:
            account
        },
        200
      );
    }

    /*
     * We found the account.
     * Now request the authenticated
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
          account_id:
            accountId,
          http_status:
            otpResponse.status,
          deriv_response:
            otpData
        },
        otpResponse.status
      );
    }

    /*
     * IMPORTANT:
     * We have deliberately stopped here.
     *
     * No proposal is requested.
     * No trade is purchased.
     *
     * We are only confirming that the
     * authenticated Options WebSocket
     * connection can be created.
     */

    return json({
      ok: true,
      connected: true,
      stage:
        "authenticated-options-account",
      account: {
        account_id:
          account.account_id ||
          account.id ||
          account.loginid ||
          null,
        account_type:
          account.account_type ||
          null,
        currency:
          account.currency ||
          null,
        status:
          account.status ||
          null
      },
      message:
        "Deriv Options account found and authenticated WebSocket URL created successfully. No trade was placed."
    });

  } catch (error) {

    console.error(
      "DollarTicks trading connection error:",
      error
    );

    return json(
      {
        ok: false,
        connected: true,
        stage:
          "server-error",
        error:
          error.message ||
          "Unable to communicate with Deriv."
      },
      500
    );
  }
}
