export async function onRequest(context) {
  const request = context.request;

  // Allow the browser to check the connection.
  if (request.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        connected: true,
        message: "DollarTicks trading endpoint is active."
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  // Only POST is used for trading requests.
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Method not allowed."
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  try {
    const body = await request.json();

    /*
     * For now we validate the proposal information.
     * We are NOT buying a contract here.
     */

    if (body.action !== "proposal") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Only proposal requests are enabled."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const {
      market,
      contract_type,
      barrier,
      stake,
      duration,
      duration_unit
    } = body;

    if (!market) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Market is required."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    if (!contract_type) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Contract type is required."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    if (!Number.isFinite(Number(stake)) || Number(stake) <= 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Invalid stake."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    if (
      !Number.isInteger(Number(duration)) ||
      Number(duration) < 1
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Invalid duration."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    /*
     * IMPORTANT:
     * This response is deliberately only a validation response.
     * No Deriv contract is purchased.
     */

    return new Response(
      JSON.stringify({
        ok: true,
        proposal: {
          market,
          contract_type,
          barrier,
          stake: Number(stake),
          duration: Number(duration),
          duration_unit: duration_unit || "t"
        },
        message:
          "Proposal parameters received. No trade was purchased."
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (error) {

    console.error(error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: "Invalid request."
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}
