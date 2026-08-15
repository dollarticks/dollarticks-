function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(
    new RegExp("(^|;\\s*)" + name + "=([^;]*)")
  );

  return match ? decodeURIComponent(match[2]) : null;
}

export async function onRequest(context) {
  const token = getCookie(context.request, "dt_access_token");

  if (!token) {
    return Response.json(
      { ok: false, error: "Not connected to Deriv." },
      { status: 401 }
    );
  }

  const APP_ID = "347btQbpUS2La9uhcLb2X";

  const accountsResponse = await fetch(
    "https://api.derivws.com/trading/v1/options/accounts",
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Deriv-App-ID": APP_ID,
        "Content-Type": "application/json"
      }
    }
  );

  const accountsData = await accountsResponse.json();

  if (!accountsResponse.ok) {
    return Response.json(
      {
        ok: false,
        error: "Could not retrieve your Deriv account.",
        details: accountsData
      },
      { status: accountsResponse.status }
    );
  }

  return Response.json({
    ok: true,
    accounts: accountsData.data || accountsData
  });
      }
