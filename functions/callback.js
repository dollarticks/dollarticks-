export async function onRequest(context) {
  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return new Response("No authorization code received.", { status: 400 });
  }

  return new Response(
    `<html>
      <head><title>DollarTicks</title></head>
      <body>
        <h2>DollarTicks</h2>
        <p>Deriv authorization received successfully.</p>
        <p>You can close this page.</p>
      </body>
    </html>`,
    {
      headers: { "Content-Type": "text/html" }
    }
  );
}
