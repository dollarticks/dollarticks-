export async function onRequest(context) {
  const url = new URL(context.request.url);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<h2>DollarTicks</h2><p>Deriv authorization was cancelled or failed.</p><p>${error}</p>`,
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  if (!code || !returnedState) {
    return new Response(
      "<h2>DollarTicks</h2><p>Missing authorization code or state.</p>",
      {
        status: 400,
        headers: { "Content-Type": "text/html" }
      }
    );
  }

  return new Response(
    `<h2>DollarTicks</h2>
     <p>Authorization response received.</p>
     <p>OAuth security verification will be completed next.</p>`,
    {
      headers: { "Content-Type": "text/html" }
    }
  );
}
