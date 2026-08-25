const CLIENT_ID = "347btQbpUS2La9uhcLb2X";
const DERIV_API = "https://api.derivws.com";

/* =====================================================
   DOLLARTICKS - MULTI STRATEGY ENGINE
   =====================================================

   STRATEGIES

   UNDER 7
   - green < 7
   - red < 7
   - green appears before red
   - trigger: moving tick touches 8 or 9
   - contract: DIGITUNDER barrier 7

   OVER 5
   - red = 0 or 1
   - green = 8 or 9
   - trigger: moving tick touches 0 or 1
   - contract: DIGITOVER barrier 5

   OVER 7
   - green = 9
   - red = 0
   - 8 and 9 > 12.5%
   - 0-6 < 10%
   - trigger after minimum 4 qualifying digit touches
   - enter on 4th

   OVER 6
   - green = 9
   - red = 0
   - 9 > 12.5%
   - 0 <= 8.5%
   - 6,7,8 > 10.5%
   - 6,7,8,9 must not decrease by 0.1%
   - minimum 3 digits below 6 touched
   - 1 must be last
   - enter on 1

   UNDER 4
   - green = 0
   - red = 9 OR 1
   - digits 5-9 < 10%
   - digits 0-4 > 10.5%
   - minimum 4 digits above 4 touched
   - enter on 4th qualifying touch

   ===================================================== */


/* =====================================================
   RESPONSE
===================================================== */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}


/* =====================================================
   COOKIE
===================================================== */

function getCookie(request, name) {
  const cookies =
    request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const i = part.indexOf("=");

    if (i === -1) continue;

    const key =
      part.slice(0, i).trim();

    if (key !== name) continue;

    try {
      return decodeURIComponent(
        part.slice(i + 1).trim()
      );
    } catch {
      return part.slice(i + 1).trim();
    }
  }

  return null;
}


/* =====================================================
   ACCOUNTS
===================================================== */

async function getAccounts(token) {
  const response = await fetch(
    `${DERIV_API}/trading/v1/options/accounts`,
    {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${token}`,

        "Deriv-App-ID":
          CLIENT_ID,

        Accept:
          "application/json"
      },
      cache: "no-store"
    }
  );

  const raw =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    throw new Error(
      "Trading service returned an invalid account response."
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.errors?.[0]?.detail?.message ||
      data?.error?.message ||
      "Could not retrieve trading accounts."
    );
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (
    data?.data &&
    typeof data.data === "object"
  ) {
    return [data.data];
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}


function getAccountId(account) {
  return (
    account?.account_id ||
    account?.loginid ||
    account?.id ||
    null
  );
}


function getAccountType(account) {
  return String(
    account?.account_type || "demo"
  ).toLowerCase();
}


function getAccountBalance(account) {
  const value =
    Number(account?.balance ?? 0);

  return Number.isFinite(value)
    ? value
    : 0;
}


function findAccount(
  accounts,
  requestedType
) {
  const wanted =
    String(
      requestedType || "demo"
    ).toLowerCase();

  return (
    accounts.find(
      account =>
        getAccountType(account) === wanted
    ) || null
  );
}


async function getSelectedAccount(
  token,
  requestedType
) {
  const accounts =
    await getAccounts(token);

  if (!accounts.length) {
    throw new Error(
      "No trading account is available."
    );
  }

  const account =
    findAccount(
      accounts,
      requestedType
    );

  if (!account) {
    throw new Error(
      `No ${String(
        requestedType
      ).toUpperCase()} trading account is available.`
    );
  }

  const accountId =
    getAccountId(account);

  if (!accountId) {
    throw new Error(
      "Trading account information is incomplete."
    );
  }

  return {
    account,
    accountId,
    accountType:
      getAccountType(account),
    balance:
      getAccountBalance(account),
    currency:
      account.currency || "USD"
  };
}


/* =====================================================
   OTP
===================================================== */

async function getOTP(
  token,
  accountId
) {
  const response =
    await fetch(
      `${DERIV_API}/trading/v1/options/accounts/${encodeURIComponent(
        accountId
      )}/otp`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Deriv-App-ID":
            CLIENT_ID,

          Accept:
            "application/json"
        },

        cache: "no-store"
      }
    );

  const raw =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    throw new Error(
      `Trading session returned HTTP ${response.status}.`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.errors?.[0]?.detail?.message ||
      data?.error?.message ||
      data?.message ||
      `Could not create trading session. HTTP ${response.status}`
    );
  }

  const wsUrl =
    data?.data?.url ||
    data?.url;

  if (!wsUrl) {
    throw new Error(
      "Trading service did not return a WebSocket URL."
    );
  }

  if (
    !String(wsUrl).startsWith("wss://")
  ) {
    throw new Error(
      "Invalid trading WebSocket URL."
    );
  }

  return wsUrl;
}


/* =====================================================
   WEBSOCKET
===================================================== */

function openWebSocket(wsUrl) {
  return new Promise(
    (resolve, reject) => {
      let ws;

      const timeout =
        setTimeout(() => {
          try {
            ws?.close();
          } catch {}

          reject(
            new Error(
              "Trading connection timed out."
            )
          );
        }, 10000);

      try {
        ws =
          new WebSocket(wsUrl);
      } catch {
        clearTimeout(timeout);

        reject(
          new Error(
            "Could not open trading connection."
          )
        );

        return;
      }

      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve(ws);
        }
      );

      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);

          try {
            ws?.close();
          } catch {}

          reject(
            new Error(
              "Trading connection failed."
            )
          );
        }
      );
    }
  );
}


function closeWebSocket(ws) {
  try {
    if (
      ws &&
      (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      )
    ) {
      ws.close();
    }
  } catch {}
}


/* =====================================================
   REQUEST
===================================================== */

function sendRequest(
  ws,
  payload,
  wantedMsgType,
  timeoutMs = 10000
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;

      const timeout =
        setTimeout(() => {
          if (finished) return;

          finished = true;
          cleanup();

          reject(
            new Error(
              `Trading service timed out waiting for ${wantedMsgType}.`
            )
          );
        }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);

        ws.removeEventListener(
          "message",
          onMessage
        );

        ws.removeEventListener(
          "error",
          onError
        );

        ws.removeEventListener(
          "close",
          onClose
        );
      }

      function fail(message) {
        if (finished) return;

        finished = true;
        cleanup();

        reject(
          new Error(message)
        );
      }

      function onMessage(event) {
        let data;

        try {
          data =
            JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.error) {
          fail(
            data.error.message ||
            data.error?.detail?.message ||
            "Deriv rejected the request."
          );

          return;
        }

        if (
          data.msg_type ===
          wantedMsgType
        ) {
          if (finished) return;

          finished = true;
          cleanup();

          resolve(data);
        }
      }

      function onError() {
        fail(
          "Trading connection failed."
        );
      }

      function onClose() {
        fail(
          "Trading connection closed."
        );
      }

      ws.addEventListener(
        "message",
        onMessage
      );

      ws.addEventListener(
        "error",
        onError
      );

      ws.addEventListener(
        "close",
        onClose
      );

      try {
        ws.send(
          JSON.stringify(payload)
        );
      } catch {
        fail(
          "Could not send trading request."
        );
      }
    }
  );
}


/* =====================================================
   VOLATILITY MARKETS
===================================================== */

const VOLATILITY_SYMBOLS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",

  "1HZ10V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ100V",

  "JD10",
  "JD25",
  "JD50",
  "JD75",
  "JD100"
];


/* =====================================================
   DIGIT
===================================================== */

function getLastDigit(quote) {
  const text =
    String(quote);

  const clean =
    text.replace(
      /[^0-9]/g,
      ""
    );

  if (!clean.length) {
    return null;
  }

  return Number(
    clean.charAt(
      clean.length - 1
    )
  );
}


/* =====================================================
   DIGIT STATISTICS
===================================================== */

function makeDigitStats(
  digits
) {
  const counts =
    Array(10).fill(0);

  for (const digit of digits) {
    if (
      Number.isInteger(digit) &&
      digit >= 0 &&
      digit <= 9
    ) {
      counts[digit]++;
    }
  }

  const total =
    digits.length;

  const percentages =
    counts.map(count =>
      total > 0
        ? (count / total) * 100
        : 0
    );

  return {
    counts,
    percentages,
    total
  };
}


/* =====================================================
   GREEN / RED
===================================================== */

function getGreenRed(
  percentages
) {
  let green = 0;
  let red = 0;

  for (
    let i = 1;
    i < percentages.length;
    i++
  ) {
    if (
      percentages[i] >
      percentages[green]
    ) {
      green = i;
    }

    if (
      percentages[i] <
      percentages[red]
    ) {
      red = i;
    }
  }

  return {
    green,
    red
  };
}


/* =====================================================
   MOVING TOUCH SEQUENCE
===================================================== */

function uniqueTouchSequence(
  digits,
  predicate
) {
  const result = [];

  for (const digit of digits) {
    if (
      !predicate(digit)
    ) {
      continue;
    }

    if (
      !result.includes(digit)
    ) {
      result.push(digit);
    }
  }

  return result;
}


/* =====================================================
   UNDER 7
===================================================== */

function checkUnder7(
  stats,
  digits
) {
  const {
    percentages
  } = stats;

  const {
    green,
    red
  } =
    getGreenRed(
      percentages
    );

  if (
    green >= 7 ||
    red >= 7
  ) {
    return {
      valid: false
    };
  }

  /*
   * Green must appear before red
   * in the recent moving sequence.
   */
  const recent =
    digits.slice(-50);

  const greenIndex =
    recent.lastIndexOf(green);

  const redIndex =
    recent.lastIndexOf(red);

  if (
    greenIndex === -1 ||
    redIndex === -1 ||
    greenIndex >= redIndex
  ) {
    return {
      valid: false
    };
  }

  const trigger =
    digits[digits.length - 1];

  if (
    trigger !== 8 &&
    trigger !== 9
  ) {
    return {
      valid: false
    };
  }

  return {
    valid: true,
    strategy: "UNDER 7",
    contract_type:
      "DIGITUNDER",
    barrier: 7,
    trigger_digit:
      trigger
  };
}


/* =====================================================
   OVER 5
===================================================== */

function checkOver5(
  stats,
  digits
) {
  const {
    green,
    red
  } =
    getGreenRed(
      stats.percentages
    );

  if (
    red !== 0 &&
    red !== 1
  ) {
    return {
      valid: false
    };
  }

  if (
    green !== 8 &&
    green !== 9
  ) {
    return {
      valid: false
    };
  }

  const trigger =
    digits[digits.length - 1];

  if (
    trigger !== 0 &&
    trigger !== 1
  ) {
    return {
      valid: false
    };
  }

  return {
    valid: true,
    strategy: "OVER 5",
    contract_type:
      "DIGITOVER",
    barrier: 5,
    trigger_digit:
      trigger
  };
}


/* =====================================================
   OVER 7
===================================================== */

function checkOver7(
  stats,
  digits
) {
  const {
    green,
    red
  } =
    getGreenRed(
      stats.percentages
    );

  const p =
    stats.percentages;

  if (green !== 9) {
    return {
      valid: false
    };
  }

  if (red !== 0) {
    return {
      valid: false
    };
  }

  if (
    p[8] <= 12.5 ||
    p[9] <= 12.5
  ) {
    return {
      valid: false
    };
  }

  for (
    let i = 0;
    i <= 6;
    i++
  ) {
    if (p[i] >= 10) {
      return {
        valid: false
      };
    }
  }

  const sequence =
    uniqueTouchSequence(
      digits.slice(-100),
      d => d >= 0 && d <= 6
    );

  /*
   * User requires a minimum
   * of 4 digits touched.
   */
  if (
    sequence.length < 4
  ) {
    return {
      valid: false
    };
  }

  /*
   * Enter when moving tick is
   * touching the 4th qualifying
   * number.
   */
  const fourth =
    sequence[3];

  const current =
    digits[digits.length - 1];

  if (
    current !== fourth
  ) {
    return {
      valid: false
    };
  }

  return {
    valid: true,
    strategy: "OVER 7",
    contract_type:
      "DIGITOVER",
    barrier: 7,
    trigger_digit:
      current,
    touch_count:
      sequence.length
  };
}


/* =====================================================
   OVER 6
===================================================== */

function checkOver6(
  stats,
  digits,
  previousPercentages
) {
  const {
    green,
    red
  } =
    getGreenRed(
      stats.percentages
    );

  const p =
    stats.percentages;

  if (green !== 9) {
    return {
      valid: false
    };
  }

  if (red !== 0) {
    return {
      valid: false
    };
  }

  if (p[9] <= 12.5) {
    return {
      valid: false
    };
  }

  if (p[0] > 8.5) {
    return {
      valid: false
    };
  }

  if (
    p[6] <= 10.5 ||
    p[7] <= 10.5 ||
    p[8] <= 10.5
  ) {
    return {
      valid: false
    };
  }

  /*
   * Reject if any of 6,7,8,9
   * has decreased by even 0.1%.
   */
  if (
    previousPercentages
  ) {
    for (
      const digit of [6, 7, 8, 9]
    ) {
      if (
        p[digit] <
        previousPercentages[digit] - 0.000001
      ) {
        return {
          valid: false,
          reason:
            "6-9 percentage decreased"
        };
      }
    }
  }

  /*
   * At least 3 unique digits
   * below 6 must be touched.
   */
  const belowSix =
    uniqueTouchSequence(
      digits.slice(-100),
      d =>
        d >= 0 &&
        d < 6
    );

  if (
    belowSix.length < 3
  ) {
    return {
      valid: false
    };
  }

  /*
   * 1 must ALWAYS be the last
   * qualifying digit touched.
   */
  const current =
    digits[digits.length - 1];

  if (current !== 1) {
    return {
      valid: false
    };
  }

  const lastThree =
    belowSix.slice(-3);

  if (
    lastThree[lastThree.length - 1] !== 1
  ) {
    return {
      valid: false
    };
  }

  return {
    valid: true,
    strategy: "OVER 6",
    contract_type:
      "DIGITOVER",
    barrier: 6,
    trigger_digit:
      1,
    touch_count:
      belowSix.length
  };
}


/* =====================================================
   UNDER 4
===================================================== */

function checkUnder4(
  stats,
  digits
) {
  const {
    green,
    red
  } =
    getGreenRed(
      stats.percentages
    );

  const p =
    stats.percentages;

  /*
   * Required:
   * green = 0
   * red = 9 OR 1
   */
  if (green !== 0) {
    return {
      valid: false
    };
  }

  if (
    red !== 9 &&
    red !== 1
  ) {
    return {
      valid: false
    };
  }

  /*
   * Above 4 = 5,6,7,8,9
   */
  for (
    let i = 5;
    i <= 9;
    i++
  ) {
    if (p[i] >= 10) {
      return {
        valid: false
      };
    }
  }

  /*
   * 0-4 must all be > 10.5%
   */
  for (
    let i = 0;
    i <= 4;
    i++
  ) {
    if (p[i] <= 10.5) {
      return {
        valid: false
      };
    }
  }

  /*
   * At least 4 different digits
   * above 4 must have been touched.
   */
  const aboveFour =
    uniqueTouchSequence(
      digits.slice(-100),
      d => d > 4
    );

  if (
    aboveFour.length < 4
  ) {
    return {
      valid: false
    };
  }

  /*
   * Enter on the 4th number.
   */
  const fourth =
    aboveFour[3];

  const current =
    digits[digits.length - 1];

  if (
    current !== fourth
  ) {
    return {
      valid: false
    };
  }

  return {
    valid: true,
    strategy: "UNDER 4",
    contract_type:
      "DIGITUNDER",
    barrier: 4,
    trigger_digit:
      current,
    touch_count:
      aboveFour.length
  };
}


/* =====================================================
   ALL STRATEGIES
===================================================== */

function analyseStrategies(
  digits,
  previousPercentages = null
) {
  if (
    !Array.isArray(digits) ||
    digits.length < 20
  ) {
    return {
      ready: false,
      reason:
        "Not enough tick data.",
      signals: []
    };
  }

  const stats =
    makeDigitStats(
      digits
    );

  const signals = [];

  const strategies = [
    checkUnder7(
      stats,
      digits
    ),

    checkOver5(
      stats,
      digits
    ),

    checkOver7(
      stats,
      digits
    ),

    checkOver6(
      stats,
      digits,
      previousPercentages
    ),

    checkUnder4(
      stats,
      digits
    )
  ];

  for (
    const signal of strategies
  ) {
    if (signal.valid) {
      signals.push(signal);
    }
  }

  return {
    ready: true,

    stats: {
      counts:
        stats.counts,

      percentages:
        stats.percentages,

      total:
        stats.total,

      greenRed:
        getGreenRed(
          stats.percentages
        )
    },

    current_digit:
      digits[digits.length - 1],

    signals
  };
}


/* =====================================================
   MARKET HISTORY
===================================================== */

async function getPublicTicks(
  symbol,
  count = 100
) {
  return new Promise(
    (resolve, reject) => {
      const ws =
        new WebSocket(
          "wss://api.derivws.com/trading/v1/options/ws/public"
        );

      let finished =
        false;

      const timeout =
        setTimeout(() => {
          if (finished) return;

          finished = true;

          try {
            ws.close();
          } catch {}

          reject(
            new Error(
              `Timed out fetching ticks for ${symbol}.`
            )
          );
        }, 10000);

      function finish(
        callback
      ) {
        if (finished) return;

        finished = true;
        clearTimeout(timeout);

        try {
          ws.close();
        } catch {}

        callback();
      }

      ws.addEventListener(
        "open",
        () => {
          ws.send(
            JSON.stringify({
              ticks_history:
                symbol,

              count:
                Math.min(
                  Math.max(
                    Number(count) || 100,
                    20
                  ),
                  1000
                ),

              end:
                "latest",

              style:
                "ticks",

              req_id:
                7101
            })
          );
        }
      );

      ws.addEventListener(
        "message",
        event => {
          let data;

          try {
            data =
              JSON.parse(
                event.data
              );
          } catch {
            return;
          }

          if (data.error) {
            finish(() => {
              reject(
                new Error(
                  data.error.message ||
                  "Could not retrieve market ticks."
                )
              );
            });

            return;
          }

          if (
            data.msg_type !==
            "history"
          ) {
            return;
          }

          const prices =
            data?.history?.prices ||
            [];

          const digits =
            prices
              .map(
                getLastDigit
              )
              .filter(
                d =>
                  Number.isInteger(d)
              );

          finish(() => {
            resolve({
              symbol,
              digits,
              prices,
              total:
                digits.length
            });
          });
        }
      );

      ws.addEventListener(
        "error",
        () => {
          finish(() => {
            reject(
              new Error(
                `Market data connection failed for ${symbol}.`
              )
            );
          });
        }
      );
    }
  );
}


/* =====================================================
   ANALYSE ONE MARKET
===================================================== */

async function analyseMarket(
  symbol,
  count = 100
) {
  const data =
    await getPublicTicks(
      symbol,
      count
    );

  const analysis =
    analyseStrategies(
      data.digits
    );

  return {
    symbol,
    ...analysis
  };
}


/* =====================================================
   ANALYSE ALL VOLATILITY MARKETS
===================================================== */

async function analyseAllMarkets(
  count = 100
) {
  /*
   * Do not make hundreds of requests.
   * Analyse the supported volatility
   * markets in small batches.
   */

  const results = [];

  for (
    let i = 0;
    i < VOLATILITY_SYMBOLS.length;
    i += 5
  ) {
    const batch =
      VOLATILITY_SYMBOLS.slice(
        i,
        i + 5
      );

    const batchResults =
      await Promise.allSettled(
        batch.map(
          symbol =>
            analyseMarket(
              symbol,
              count
            )
        )
      );

    for (
      const result of batchResults
    ) {
      if (
        result.status ===
        "fulfilled"
      ) {
        results.push(
          result.value
        );
      }
    }
  }

  /*
   * Flatten all valid strategy
   * signals.
   */
  const opportunities = [];

  for (
    const market of results
  ) {
    if (
      Array.isArray(
        market.signals
      )
    ) {
      for (
        const signal of market.signals
      ) {
        opportunities.push({
          market:
            market.symbol,

          ...signal,

          percentages:
            market.stats
              ?.percentages ||
            [],

          counts:
            market.stats
              ?.counts ||
            [],

          current_digit:
            market.current_digit
        });
      }
    }
  }

  return {
    ok: true,

    markets:
      results,

    opportunities
  };
}


/* =====================================================
   PROPOSAL
===================================================== */

const DIGIT_CONTRACTS =
  new Set([
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITDIFF"
  ]);


function buildProposalPayload({
  market,
  contractType,
  stake,
  duration,
  durationUnit,
  currency,
  barrier
}) {
  const payload = {
    proposal: 1,

    amount:
      stake,

    basis:
      "stake",

    contract_type:
      contractType,

    currency,

    duration,

    duration_unit:
      durationUnit,

    underlying_symbol:
      market,

    req_id:
      4001
  };

  if (
    DIGIT_CONTRACTS.has(
      contractType
    )
  ) {
    const digit =
      Number(barrier);

    if (
      !Number.isInteger(digit) ||
      digit < 0 ||
      digit > 9
    ) {
      throw new Error(
        "Digit barrier must be between 0 and 9."
      );
    }

    payload.barrier =
      String(digit);
  }

  return payload;
}


/* =====================================================
   NORMALIZE CONTRACT
===================================================== */

function normalizeContract(
  source,
  fallbackContractId
) {
  const rawStatus =
    String(
      source?.status ||
      source?.contract_status ||
      ""
    ).toUpperCase();

  const isSold =
    source?.is_sold === true ||
    source?.is_sold === 1 ||
    source?.is_expired === true ||
    source?.is_expired === 1;

  const profit =
    Number(
      source?.profit ?? 0
    );

  let status =
    rawStatus;

  if (
    isSold &&
    status !== "WON" &&
    status !== "LOST"
  ) {
    status =
      profit > 0
        ? "WON"
        : "LOST";
  }

  if (!status) {
    status =
      isSold
        ? (
            profit > 0
              ? "WON"
              : "LOST"
          )
        : "OPEN";
  }

  return {
    contract_id:
      Number(
        source?.contract_id ??
        fallbackContractId
      ),

    status,

    is_sold:
      isSold,

    buy_price:
      Number(
        source?.buy_price ??
        source?.buy_price_amount ??
        0
      ),

    payout:
      Number(
        source?.payout ?? 0
      ),

    profit:
      Number.isFinite(profit)
        ? profit
        : 0,

    entry_spot:
      source?.entry_spot ??
      source?.entry_tick ??
      source?.entry_tick_display_value ??
      source?.start_spot ??
      source?.spot_entry ??
      null,

    exit_spot:
      source?.exit_spot ??
      source?.sell_spot ??
      source?.exit_tick ??
      source?.exit_tick_display_value ??
      source?.spot_exit ??
      null,

    sell_price:
      Number(
        source?.sell_price ??
        source?.bid_price ??
        0
      ),

    contract_type:
      source?.contract_type ||
      null,

    underlying_symbol:
      source?.underlying_symbol ||
      source?.symbol ||
      null,

    barrier:
      source?.barrier ??
      null,

    currency:
      source?.currency ||
      null,

    date_start:
      source?.date_start ??
      null,

    date_expiry:
      source?.date_expiry ??
      null,

    expiry_time:
      source?.expiry_time ??
      null
  };
}


/* =====================================================
   CONTRACT RESULT
===================================================== */

async function getContractResult(
  token,
  accountId,
  contractId
) {
  let ws;

  try {
    const wsUrl =
      await getOTP(
        token,
        accountId
      );

    ws =
      await openWebSocket(
        wsUrl
      );

    return await new Promise(
      (resolve, reject) => {
        let finished =
          false;

        const timeout =
          setTimeout(() => {
            finish({
              contract: {
                contract_id:
                  Number(
                    contractId
                  ),

                status:
                  "OPEN",

                is_sold:
                  false,

                profit:
                  0,

                entry_spot:
                  null,

                exit_spot:
                  null
              }
            });
          }, 8000);

        function cleanup() {
          clearTimeout(
            timeout
          );

          ws.removeEventListener(
            "message",
            onMessage
          );

          ws.removeEventListener(
            "error",
            onError
          );

          ws.removeEventListener(
            "close",
            onClose
          );
        }

        function finish(
          result
        ) {
          if (finished) return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          resolve(result);
        }

        function fail(
          error
        ) {
          if (finished) return;

          finished = true;

          cleanup();

          closeWebSocket(ws);

          reject(
            error instanceof Error
              ? error
              : new Error(
                  String(error)
                )
          );
        }

        function onMessage(
          event
        ) {
          let data;

          try {
            data =
              JSON.parse(
                event.data
              );
          } catch {
            return;
          }

          if (data.error) {
            fail(
              new Error(
                data.error.message ||
                data.error?.detail?.message ||
                "Deriv rejected the request."
              )
            );

            return;
          }

          if (
            data.msg_type !==
            "proposal_open_contract"
          ) {
            return;
          }

          const raw =
            data.proposal_open_contract;

          if (!raw) return;

          if (
            Number(
              raw.contract_id
            ) !==
            Number(contractId)
          ) {
            return;
          }

          const contract =
            normalizeContract(
              raw,
              contractId
            );

          const complete =
            contract.is_sold ||
            contract.status === "WON" ||
            contract.status === "LOST";

          if (complete) {
            finish({
              contract
            });
          }
        }

        function onError() {
          fail(
            new Error(
              "Trading connection failed."
            )
          );
        }

        function onClose() {
          if (!finished) {
            fail(
              new Error(
                "Trading connection closed."
              )
            );
          }
        }

        ws.addEventListener(
          "message",
          onMessage
        );

        ws.addEventListener(
          "error",
          onError
        );

        ws.addEventListener(
          "close",
          onClose
        );

        try {
          ws.send(
            JSON.stringify({
              proposal_open_contract:
                1,

              contract_id:
                Number(
                  contractId
                ),

              subscribe:
                1,

              req_id:
                9001
            })
          );
        } catch(error) {
          fail(error);
        }
      }
    );
  } finally {
    closeWebSocket(ws);
  }
}


/* =====================================================
   BUY
===================================================== */

async function buyContract({
  token,
  accountId,
  accountType,
  currency,
  market,
  contractType,
  stake,
  duration,
  durationUnit,
  barrier
}) {
  let ws;

  try {
    const wsUrl =
      await getOTP(
        token,
        accountId
      );

    ws =
      await openWebSocket(
        wsUrl
      );

    const proposalPayload =
      buildProposalPayload({
        market,
        contractType,
        stake,
        duration,
        durationUnit,
        currency,
        barrier
      });

    const proposalResponse =
      await sendRequest(
        ws,
        proposalPayload,
        "proposal",
        10000
      );

    const proposal =
      proposalResponse?.proposal;

    if (!proposal?.id) {
      throw new Error(
        "Deriv did not return a valid proposal."
      );
    }

    const askPrice =
      Number(
        proposal.ask_price ??
        proposal.display_value ??
        stake
      );

    if (
      !Number.isFinite(
        askPrice
      ) ||
      askPrice <= 0
    ) {
      throw new Error(
        "Deriv returned an invalid contract price."
      );
    }

    const buyResponse =
      await sendRequest(
        ws,

        {
          buy:
            String(
              proposal.id
            ),

          price:
            askPrice,

          req_id:
            4002
        },

        "buy",

        10000
      );

    const buy =
      buyResponse?.buy;

    if (
      !buy?.contract_id
    ) {
      throw new Error(
        "Deriv did not return a contract ID."
      );
    }

    return {
      contract_id:
        Number(
          buy.contract_id
        ),

      buy_price:
        Number(
          buy.buy_price ??
          askPrice
        ),

      payout:
        Number(
          buy.payout ??
          proposal.payout ??
          0
        ),

      profit:
        Number(
          buy.profit ??
          0
        ),

      status:
        String(
          buy.status ||
          "OPEN"
        ).toUpperCase(),

      account_type:
        accountType,

      account_id:
        accountId,

      market,

      underlying_symbol:
        market,

      contract_type:
        contractType,

      barrier:
        DIGIT_CONTRACTS.has(
          contractType
        )
          ? String(barrier)
          : null,

      entry_spot:
        buy.entry_spot ??
        buy.entry_tick ??
        buy.start_spot ??
        proposal.spot ??
        null,

      exit_spot:
        null
    };
  } finally {
    closeWebSocket(ws);
  }
}


/* =====================================================
   MAIN
===================================================== */

export async function onRequest(
  context
) {
  const request =
    context.request;

  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return json(
      {
        ok: false,
        error:
          "Method not allowed."
      },
      405
    );
  }

  const token =
    getCookie(
      request,
      "dt_access_token"
    );

  if (!token) {
    return json(
      {
        ok: false,
        connected: false,
        error:
          "Trading session unavailable. Please log in again."
      },
      401
    );
  }

  let body = {};

  if (
    request.method === "POST"
  ) {
    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          ok: false,
          error:
            "Invalid trading request."
        },
        400
      );
    }
  }

  /* =====================================================
     ACCOUNT TYPE
  ===================================================== */

  let requestedType =
    "demo";

  try {
    const url =
      new URL(
        request.url
      );

    const queryType =
      url.searchParams.get(
        "account_type"
      );

    if (
      queryType === "demo" ||
      queryType === "real"
    ) {
      requestedType =
        queryType;
    }
  } catch {}

  if (
    body.account_type === "demo" ||
    body.account_type === "real"
  ) {
    requestedType =
      body.account_type;
  }

  /* =====================================================
     ACCOUNT
  ===================================================== */

  let selected;

  try {
    selected =
      await getSelectedAccount(
        token,
        requestedType
      );
  } catch(error) {
    return json(
      {
        ok: false,
        connected: false,
        error:
          error.message ||
          "Trading account unavailable."
      },
      400
    );
  }

  const {
    account,
    accountId,
    accountType,
    balance,
    currency
  } = selected;


  /* =====================================================
     GET
  ===================================================== */

  if (
    request.method === "GET"
  ) {
    return json({
      ok: true,

      connected: true,

      account: {
        account_id:
          accountId,

        account_type:
          accountType,

        balance,

        currency,

        status:
          account.status ||
          "active"
      }
    });
  }


  /* =====================================================
     BALANCE
  ===================================================== */

  if (
    body.action ===
    "balance"
  ) {
    try {
      const accounts =
        await getAccounts(
          token
        );

      const fresh =
        findAccount(
          accounts,
          accountType
        );

      if (fresh) {
        return json({
          ok: true,

          account: {
            account_id:
              getAccountId(
                fresh
              ),

            account_type:
              getAccountType(
                fresh
              )
          },

          balance:
            getAccountBalance(
              fresh
            ),

          currency:
            fresh.currency ||
            currency
        });
      }
    } catch {}

    return json({
      ok: true,

      account: {
        account_id:
          accountId,

        account_type:
          accountType
      },

      balance,

      currency
    });
  }


  /* =====================================================
     SELECT ACCOUNT
  ===================================================== */

  if (
    body.action ===
    "select_account"
  ) {
    return json({
      ok: true,

      connected: true,

      account: {
        account_id:
          accountId,

        account_type:
          accountType,

        balance,

        currency,

        status:
          account.status ||
          "active"
      }
    });
  }


  /* =====================================================
     SESSION
  ===================================================== */

  if (
    body.action ===
      "session" ||
    body.action ===
      "trading_session"
  ) {
    let ws;

    try {
      const wsUrl =
        await getOTP(
          token,
          accountId
        );

      ws =
        await openWebSocket(
          wsUrl
        );

      const result =
        await sendRequest(
          ws,

          {
            balance: 1,

            req_id:
              3001
          },

          "balance",

          10000
        );

      return json({
        ok: true,

        connected: true,

        trading_ready:
          true,

        balance:
          result?.balance?.balance ??
          balance,

        currency:
          result?.balance?.currency ??
          currency,

        account: {
          account_id:
            accountId,

          account_type:
            accountType
        }
      });
    } catch(error) {
      return json(
        {
          ok: false,

          connected: true,

          trading_ready:
            false,

          error:
            error.message ||
            "Trading session failed."
        },
        502
      );
    } finally {
      closeWebSocket(ws);
    }
  }


  /* =====================================================
     STRATEGY ANALYSE
  ===================================================== */

  if (
    body.action ===
    "analyse"
  ) {
    const count =
      Math.min(
        Math.max(
          Number(
            body.count || 100
          ),
          20
        ),
        1000
      );

    try {
      const result =
        await analyseAllMarkets(
          count
        );

      return json({
        ok: true,

        engine:
          "DollarTicks Multi Strategy",

        strategies: [
          "UNDER 7",
          "OVER 5",
          "OVER 7",
          "OVER 6",
          "UNDER 4"
        ],

        ...result
      });
    } catch(error) {
      return json(
        {
          ok: false,

          error:
            error.message ||
            "Market analysis failed."
        },
        502
      );
    }
  }


  /* =====================================================
     ANALYSE ONE MARKET
  ===================================================== */

  if (
    body.action ===
    "analyse_market"
  ) {
    const market =
      String(
        body.market ||
        ""
      ).trim();

    if (!market) {
      return json(
        {
          ok: false,

          error:
            "No market supplied."
        },
        400
      );
    }

    try {
      const result =
        await analyseMarket(
          market,
          Number(
            body.count || 100
          )
        );

      return json({
        ok: true,

        ...result
      });
    } catch(error) {
      return json(
        {
          ok: false,

          error:
            error.message ||
            "Market analysis failed."
        },
        502
      );
    }
  }


  /* =====================================================
     BUY
  ===================================================== */

  if (
    body.action ===
    "buy"
  ) {
    try {
      const market =
        String(
          body.market ||
          body.underlying_symbol ||
          body.symbol ||
          ""
        ).trim();

      if (!market) {
        throw new Error(
          "No trading market was selected."
        );
      }

      const contractType =
        String(
          body.contract_type ||
          ""
        )
          .trim()
          .toUpperCase();

      if (
        contractType !==
          "DIGITOVER" &&
        contractType !==
          "DIGITUNDER"
      ) {
        throw new Error(
          "DollarTicks strategy trades must use DIGITOVER or DIGITUNDER."
        );
      }

      const stake =
        Number(
          body.stake
        );

      if (
        !Number.isFinite(
          stake
        ) ||
        stake <= 0
      ) {
        throw new Error(
          "Enter a valid stake greater than 0."
        );
      }

      const duration =
        Number(
          body.duration || 1
        );

      if (
        !Number.isFinite(
          duration
        ) ||
        duration < 1
      ) {
        throw new Error(
          "Enter a valid duration."
        );
      }

      const barrier =
        Number(
          body.barrier
        );

      if (
        !Number.isInteger(
          barrier
        ) ||
        barrier < 0 ||
        barrier > 9
      ) {
        throw new Error(
          "Invalid digit barrier."
        );
      }

      const contract =
        await buyContract({
          token,

          accountId,

          accountType,

          currency,

          market,

          contractType,

          stake,

          duration,

          durationUnit:
            "t",

          barrier
        });

      return json({
        ok: true,

        contract,

        account: {
          account_id:
            accountId,

          account_type:
            accountType,

          currency
        }
      });
    } catch(error) {
      console.error(
        "DollarTicks BUY ERROR:",
        error
      );

      return json(
        {
          ok: false,

          connected: true,

          error:
            error.message ||
            "Purchase failed."
        },
        400
      );
    }
  }


  /* =====================================================
     CONTRACT STATUS
  ===================================================== */

  if (
    body.action ===
    "contract_status"
  ) {
    const contractId =
      Number(
        body.contract_id
      );

    if (
      !Number.isFinite(
        contractId
      ) ||
      contractId <= 0
    ) {
      return json(
        {
          ok: false,

          error:
            "Invalid contract ID."
        },
        400
      );
    }

    try {
      const result =
        await getContractResult(
          token,
          accountId,
          contractId
        );

      return json({
        ok: true,

        contract:
          result.contract,

        account: {
          account_id:
            accountId,

          account_type:
            accountType
        }
      });
    } catch(error) {
      return json(
        {
          ok: false,

          connected: true,

          error:
            error.message ||
            "Could not check contract."
        },
        502
      );
    }
  }


  /* =====================================================
     UNKNOWN
  ===================================================== */

  return json(
    {
      ok: false,

      error:
        `Unknown action: ${
          body.action || "none"
        }`
    },
    400
  );
   }
