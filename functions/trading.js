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
     * Get authenticated Options accounts
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
              clientId,
            "Content-Type":
              "application/json"
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
          http_status:
            accountsResponse.status,
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

    /*
     * Some Deriv responses can return
     * a single account object in data.
     */

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
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "account-discovery",
          message:
            "Deriv authentication works, but no Options account was found.",
          deriv_response:
            accountsData
        }
      );
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
      return json(
        {
          ok: false,
          connected: true,
          stage:
            "account-id",
          message:
            "An Options account was returned, but no account ID was found.",
          account:
            account
        }
      );
    }

    /*
     * Request the short-lived authenticated
     * WebSocket URL.
     *
     * Deriv says this OTP/WebSocket URL
     * is valid for 120 seconds and can
     * only be used once.
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
     * Return ONLY the short-lived WebSocket URL.
     *
     * Never return the OAuth access token.
     */

    return json({
      ok: true,
      connected: true,
      stage:
        "authenticated-options-account",
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
      ws_url:
        otpData.data.url,
      message:
        "Authenticated Deriv Options WebSocket URL created successfully."
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
