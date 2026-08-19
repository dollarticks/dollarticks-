function findDemoAccount(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) {
    return null;
  }

  /*
   * First look for an explicitly marked demo account.
   */
  const explicitDemo = accounts.find(account => {
    const type = String(
      account.account_type || ""
    ).toLowerCase();

    return type === "demo";
  });

  if (explicitDemo) {
    return explicitDemo;
  }

  /*
   * Then look for a VRT login ID.
   */
  const vrtDemo = accounts.find(account => {
    const loginid = String(
      account.loginid || ""
    ).toUpperCase();

    return (
      loginid.startsWith("VRT") ||
      loginid.startsWith("VRTC")
    );
  });

  if (vrtDemo) {
    return vrtDemo;
  }

  /*
   * IMPORTANT:
   * DollarTicks previously returned a connected
   * Options account with a DOT account ID.
   * If there is only one Options account, use it.
   */
  const dotAccount = accounts.find(account => {
    const id = String(
      account.account_id ||
      account.id ||
      ""
    ).toUpperCase();

    return id.startsWith("DOT");
  });

  if (dotAccount) {
    return dotAccount;
  }

  /*
   * Last fallback: use the first account returned.
   */
  return accounts[0] || null;
}
