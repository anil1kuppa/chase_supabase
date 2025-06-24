import { sleep } from "https://esm.sh/@supabase/auth-js@2.69.1/dist/module/lib/helpers.js";
import { toISTString } from "./dateUtils.ts";
import { Candle, Instrument,KITE_ORDER_STATUS, TRANSACTION_TYPE,KiteOrderParams } from "./types.ts";
const KITE_API_KEY = Deno.env.get("KITE_API_KEY")!;
import Papa from 'https://esm.sh/papaparse@5.4.1'

export const getHistoricalCandles = async (
  instrument: Instrument,
  interval: string, //60minute, 5minute, 10minute, 15minute, 30minute, 1day,2minute
  intervalValue: number,
  accessToken: string,
): Promise<Array<Candle> | null> => {
  let url: string = ""
    

  let candles: Array<Candle> | null = null;
  let filteredCandles: Array<Candle> | null = null;
  let retries = 0;

  do {
    const from = toISTString(new Date(new Date().getTime() - intervalValue)); // format: YYYY-MM-DD HH:mm:ss
    const to = toISTString(new Date()); // format: YYYY-MM-DD HH:mm:ss
    url=`https://api.kite.trade/instruments/historical/${instrument.instrument_token}/${interval}?from=${from}&to=${to}`;
    const todaysDate = to.split(" ")[0];
    console.log(
      `Fetching candles for ${instrument.tradingsymbol} and token ${instrument.instrument_token} from ${from} to ${to}`,
    );
    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${KITE_API_KEY}:${accessToken}`,
        "X-Kite-Version": "3",
      },
    });

    if (!resp.ok) {
      console.error(
        `Failed to fetch data for token ${instrument.instrument_token} on attempt ${
          retries + 1
        }`,
      );
      console.error(
        `Response status: ${resp.status} and error is ${resp.body}`,
      );
      retries++;
      await sleep(2000); // Sleep for 2 seconds before retrying
      continue;
    }

    const { data } = await resp.json();
    candles = data.candles; // assume [timestamp, open, high, low, close, volume]

    if (!candles || candles.length === 0) {
      console.error(`No data for ${instrument.tradingsymbol}`);
    }
    else
    {
        filteredCandles = candles.filter((candle: Candle) =>
          candle[0].startsWith(todaysDate)
        );
        if (filteredCandles.length === 0) {
          console.error(`No candles found for the date: ${todaysDate}`);
        } else {
          console.log(`Fetched data for ${instrument.tradingsymbol}:`, candles);
        }
    }

    break; // Exit the loop if response is ok, regardless of data availability
  } while (retries < 3);

  if (!filteredCandles || filteredCandles.length === 0) {
    return null;
  } else {
    return candles;
  }
};

export const calculate40EMA = (
  candles: Array<Candle>,
  prevEMA: number | null = null,
):
  | { ema: number; highestHigh: number; lowestLow: number; lastClose: number }
  | null => {
  const period = 40; // EMA period
  const multiplier = 2 / (period + 1); // EMA multiplier

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];
  // Filter candles for the current date
  const filteredCandles = candles.filter((candle) =>
    candle[0].startsWith(today)
  );
  if (filteredCandles.length === 0) {
    console.error(`No candles found for the date: ${today}`);
    return null;
  }

  // Check if there are enough candles for the calculation
  if (!prevEMA && candles.length < period) {
    console.error(
      `Not enough candles for the calculation. Found: ${filteredCandles.length}, Required: ${period}`,
    );
    return null;
  }

  // Calculate highest high and lowest low for the given date
  const highestHigh = Math.round(
    Math.max(...filteredCandles.map((candle) => candle[2])),
  ); // High is at index 2
  const lowestLow = Math.round(
    Math.min(...filteredCandles.map((candle) => candle[3])),
  ); // Low is at index 3
  const lastClose = Math.round(filteredCandles[filteredCandles.length - 1][4]); // Close is at index 4
  // Take only the last 40 candles for EMA calculation
  //const recentCandles = candles.slice(-period);
  const hlcValues = candles.map((candle) =>
    (candle[2] + candle[3] + candle[4]) / 3); // HLC average

  // Calculate SMA if prevEMA is not provided
  let ema: number;
  if (prevEMA === null) {
    const sma40 = hlcValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const emaArray = [sma40];
    for (let i = 40; i < hlcValues.length; i++) {
      emaArray.push(hlcValues[i] * multiplier + emaArray[emaArray.length - 1] * (1 - multiplier));
    }
    ema = emaArray[emaArray.length - 1]; // Get the last EMA value
  } else {
    ema = (hlcValues[hlcValues.length - 1] * multiplier) + (prevEMA * (1 - multiplier));
  }

  return {
    ema: Math.round(ema),
    highestHigh,
    lowestLow,
    lastClose,
  };
};

export const fetchInstruments = async (access_token: string) => {
  const csvResponse = await fetch("https://api.kite.trade/instruments", {
    method: "GET",
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`
    },
  });
  if (!csvResponse.ok) {
    throw new Error(`Error fetching instruments: ${csvResponse.statusText}`);
  }
  const csvText = await csvResponse.text()

  // 2️⃣ Parse CSV
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
  if (parsed.errors.length > 0) {
    console.error('CSV Parse Errors:', parsed.errors)
    throw new Error("Error parsing CSV");
  }
   // 3️⃣ Filter rows
   const filtered = parsed.data.filter((row: any) => row.name === 'NIFTY' || row.name === 'BANKNIFTY')

   // 4️⃣ Map data for insertion
   const rowsToInsert = filtered.map((row: any) => ({
     instrument_token: parseInt(row.instrument_token),
     tradingsymbol: row.tradingsymbol,
     name: row.name,
     expiry_date: row.expiry,
     lot_size: parseInt(row.lot_size),
     exchange: row.exchange,
     segment: row.segment,
     instrument_type: row.instrument_type,
     created_at: toISTString(new Date())
   }))

   if (rowsToInsert.length === 0) {
    console.warn("No instruments to insert");
    return null;
  }
  return rowsToInsert;

 
}

export const getLTP = async (exchange:string,tradingsymbol: string,access_token: string) => {
  const url = `https://api.kite.trade/quote?i=${exchange}:${tradingsymbol}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    },
  });

  if (!response.ok) {
    console.error(`Error fetching LTP for ${tradingsymbol}: ${response.statusText}`);
    return null;
  }

  const data = await response.json();
  if (!data || !data.data || !data.data[`${exchange}:${tradingsymbol}`]) {
    console.error(`Invalid response structure for ${tradingsymbol}, Response: ${JSON.stringify(data)}`);
    return null;
  }
  return data.data[`${exchange}:${tradingsymbol}`].last_price;  
}

// cancelOrder
export const cancelOrder = async (tradingsymbol:string,transaction_type:string, access_token: string) => {
  //Fetching the oder details to ensure it exists
  let url = `https://api.kite.trade/orders`;
  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    },
  });
  if (!response.ok) {
    console.error(`Error fetching orders: ${response.statusText}`);
    return null;
  }
  let data = await response.json();
  if (!data || !data.data ) {
    console.error(`Invalid response structure for orders, Response: ${JSON.stringify(data)}`);
    return null;
  }
  const orders = data.data;
  // Find the order to cancel
  const orderToCancel = orders.find((order: any) => 
    order.tradingsymbol === tradingsymbol && order.transaction_type === transaction_type && order.status === KITE_ORDER_STATUS.TRIGGER_PENDING
  );
  if (!orderToCancel) {
    console.error(`No order found for ${tradingsymbol} with transaction type ${transaction_type} in TRIGGER PENDING status`);
    return null;
  }
  const orderId = orderToCancel.order_id;
  url = `https://api.kite.trade/orders/regular/${orderId}`;
     response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    },
  });

  if (!response.ok) {
    console.error(`Error cancelling order ${orderId}: ${response.statusText}`);
    return null;
  }

   data = await response.json();
  if (!data || !data.data) {
    console.error(`Invalid response structure for cancelling order ${orderId}, Response: ${JSON.stringify(data)}`);
    return null;
  }
  console.log(`Order ${orderId} cancelled successfully for ${tradingsymbol}; response: ${JSON.stringify(data)}`);

}

//Place Order
export const placeKiteOrder = async (
  access_token: string,
  orderParams: KiteOrderParams
): Promise<any> => {
 const myHeaders = new Headers();
  myHeaders.append("X-Kite-Version", "3");
  myHeaders.append("Authorization", `token ${KITE_API_KEY}:${access_token}`);
  myHeaders.append("Content-Type", "application/x-www-form-urlencoded");

  const urlencoded = new URLSearchParams();
  for (const [key, value] of Object.entries(orderParams)) {
    urlencoded.append(key, String(value));
  }

  const requestOptions = {
    method: "POST",
    headers: myHeaders,
    body: urlencoded
  };

  try {
    const response = await fetch("https://api.kite.trade/orders/regular", requestOptions);
    const result = await response.json();
    if (!response.ok) {
      console.error("Order placement failed:", result);
      if (result.error_type === "InputException" && result.message.includes("stoploss")) {
        console.info("Stoploss is breached,placing market order instead");
        // Place a market order instead
        const marketOrderParams: KiteOrderParams = {
          tradingsymbol: orderParams.tradingsymbol,
          exchange: orderParams.exchange,
          transaction_type: orderParams.transaction_type,
          quantity: orderParams.quantity,
          order_type: "MARKET",
          product: orderParams.product,
          tag: orderParams.tag || "chase"
        };
        return placeKiteOrder(access_token, marketOrderParams);
      }
      console.error("Order placement error:", result);
      return Promise.reject(result);
    }
    console.log("Order placed:", result);
    return Promise.resolve(result);
  } catch (error) {
    console.error("Error placing order:", error);
    return Promise.reject(error);
  }
};

export const modifyOrder = async (
  access_token: string,
  orderParams: KiteOrderParams,
  orderId: string
): Promise<any> => {
 const myHeaders = new Headers();
  myHeaders.append("X-Kite-Version", "3");
  myHeaders.append("Authorization", `token ${KITE_API_KEY}:${access_token}`);
  myHeaders.append("Content-Type", "application/x-www-form-urlencoded");

  const urlencoded = new URLSearchParams();
  for (const [key, value] of Object.entries(orderParams)) {
    urlencoded.append(key, String(value));
  }

  const requestOptions = {
    method: "PUT",
    headers: myHeaders,
    body: urlencoded
  };

  try {
    const response = await fetch(`https://api.kite.trade/orders/regular/${orderId}`, requestOptions);
    const result = await response.json();
    if (!response.ok) {
      console.error("Order modification failed:", result);
      return Promise.reject(result);
    }
    console.log("Order modified:", result);
    return Promise.resolve(result);
  } catch (error) {
    console.error("Error modifiying order:", error);
    return Promise.reject(error);
  }
};
//Place SL Order
export const placeSL = async (
  tradingsymbol: string,
  transaction_type: string,
  quantity: number,
  access_token: string,
  stoploss: number
): Promise<string | null> => {
  // 1. Fetch positions
  const positions = await fetch("https://api.kite.trade/portfolio/positions", {
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    }
  });

  if (!positions.ok) {
    console.error(`Error fetching positions: ${positions.statusText}`);
    return null;
  }
  
  // 2. Check open position
  const positionData = await positions.json();
  const instrument = positionData?.data?.net?.find(
    (p: any) => p.tradingsymbol === tradingsymbol && p.quantity != 0
  );
  
  if (!instrument) {
    console.error(`No open position for ${tradingsymbol}`);
    return null;
  }
  const actualTransactionType = instrument.quantity > 0 ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY;
  if (actualTransactionType !== transaction_type) {
    console.error(`Transaction type mismatch: expected ${actualTransactionType}, got ${transaction_type}`);
    return null;
  }
  const price=transaction_type === TRANSACTION_TYPE.BUY ? stoploss+5 : stoploss-5;

  // 3. Check existing TRIGGER PENDING orders
  const ordersResponse = await fetch("https://api.kite.trade/orders", {
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    }
  });

  if (!ordersResponse.ok) {
    console.error(`Error fetching orders: ${ordersResponse.statusText}`);
    return null;
  }

  const ordersData = await ordersResponse.json();
  const existingSL = ordersData.data.find((o: any) => 
    o.tradingsymbol === tradingsymbol &&
    o.transaction_type === transaction_type &&
    o.status ===KITE_ORDER_STATUS.TRIGGER_PENDING
  );

  // 4. Modify existing order or place new
  if (existingSL) {
      await modifyOrder(
      access_token,
      {
       trigger_price: stoploss,
       price: price
      },
      existingSL.order_id
    );
    console.log(`Modified SL order ${existingSL.order_id} to ${stoploss}`);
    return Promise.resolve("Order is modified successfully");
    }
  else {
    // Place new SL order 
    const ltp=await getLTP("NFO",tradingsymbol, access_token);
    if (ltp === null) {
      console.error(`Failed to fetch LTP for ${tradingsymbol}`);
      return null;
    }
    console.log(`LTP for ${tradingsymbol} is ${ltp}`);
    if ((transaction_type === TRANSACTION_TYPE.BUY && stoploss < ltp) ||
        (transaction_type === TRANSACTION_TYPE.SELL && stoploss > ltp)) {
      console.error(`Stoploss ${stoploss} is breached`);
      await placeKiteOrder(
      access_token,
      {
        tradingsymbol,
        exchange: "NFO",
        transaction_type: transaction_type,
        quantity,
        order_type: "MARKET",
        product: "NRML",
        tag:"chase"
      }
    );
  }
  else {
    await placeKiteOrder(
      access_token,
      {
        tradingsymbol,
        exchange: "NFO",
        transaction_type: transaction_type,
        quantity,
        order_type: "SL",
        product: "NRML",
        tag:"chase",
        trigger_price: stoploss,
        price: price
      }
    );
  }
    console.log(`Placed new SL order for ${tradingsymbol} at ${stoploss}`);
    return Promise.resolve("Order is placed successfully");
   
  }
};

export const rollOver= async (
  tradingsymbols : Array<string>,
  access_token: string): Promise<string | null> => {
    // Function to roll over positions for a list of tradingsymbols
  if (!tradingsymbols || tradingsymbols.length <2) {
    console.error("No tradingsymbols provided for rollover.");
    return null;
  }
  /*
  1. Check if there are any open positions for the trandingsymbol and order history
  2. If there is an open position and open order, modify the order to market order
  3. If there is no open order, place a new market order for the tradingsymbol
  4. Create a new order for the second instrument with the same quantity and product type
  
  */
    // 1. Fetch positions
  const positions = await fetch("https://api.kite.trade/portfolio/positions", {
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    }
  });

  if (!positions.ok) {
    console.error(`Error fetching positions: ${positions.statusText}`);
    return null;
  }
  
  // 2. Check open position
  const positionData = await positions.json();
  const instrument = positionData?.data?.net?.find(
    (p: any) => p.tradingsymbol === tradingsymbols[0] && p.quantity != 0
  );
  
  if (!instrument) {
    console.error(`No open position for ${tradingsymbols[0]}`);
    return null;
  }
  //3. Check existing TRIGGER PENDING orders
  const ordersResponse = await fetch("https://api.kite.trade/orders", {
    headers: {
      Authorization: `token ${KITE_API_KEY}:${access_token}`,
      "X-Kite-Version": "3"
    }
  });
  if (!ordersResponse.ok) {
    console.error(`Error fetching orders: ${ordersResponse.statusText}`);
    return null;
  }
  const ordersData = await ordersResponse.json();
  const existingOrder = ordersData.data.find((o: any) =>
    o.tradingsymbol === tradingsymbols[0] &&
    o.transaction_type === (instrument.quantity > 0 ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY) &&
    o.status === KITE_ORDER_STATUS.TRIGGER_PENDING
  );
  // 4. Modify existing order or place new
  if (existingOrder) {
    // Modify existing order to market order
    const modifiedOrderParams: KiteOrderParams = {
      order_type: "MARKET"
    };
    try {
      await modifyOrder(access_token, modifiedOrderParams, existingOrder.order_id);
      console.log(`Modified order ${existingOrder.order_id} to market order for ${tradingsymbols[0]}`);
    } catch (error) {
      console.error(`Failed to modify order for ${tradingsymbols[0]}:`, error);
      return null;
    } 
  }
  else {
    // Place new market order
    const orderParams: KiteOrderParams = {
      tradingsymbol:tradingsymbols[0],
      exchange: "NFO",
      transaction_type: instrument.quantity > 0 ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY,
      quantity: Math.abs(instrument.quantity),
      order_type: "MARKET",
      product: "NRML",
      tag: "chase"
    };
    try {
      await placeKiteOrder(access_token, orderParams);
    } catch (error) {
      console.error(`Failed to place rollover order for ${tradingsymbols[0]}:`, error);
      return null;
    }
  }
  // 5. Place new order for the second instrument
  const secondInstrument = tradingsymbols[1];
  const secondOrderParams: KiteOrderParams = {
    tradingsymbol: secondInstrument,
    exchange: "NFO",
    transaction_type: instrument.quantity > 0 ? TRANSACTION_TYPE.BUY : TRANSACTION_TYPE.SELL,
    quantity: Math.abs(instrument.quantity),
    order_type: "MARKET",
    product: "NRML",
    tag: "chase"
  };
  try {
    await placeKiteOrder(access_token, secondOrderParams);
    console.log(`Placed new order for ${secondInstrument}`);
  } catch (error) {
    console.error(`Failed to place rollover order for ${secondInstrument}:`, error);
  } 
  return Promise.resolve("Rollover completed successfully");
};



