import { sleep } from "https://esm.sh/@supabase/auth-js@2.69.1/dist/module/lib/helpers.js";
import { toISTString } from "./dateUtils.ts";
import { Candle, Instrument } from "./types.ts";
const KITE_API_KEY = Deno.env.get("KITE_API_KEY")!;

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
  if (candles.length < period) {
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
    (candle[2] + candle[3] + candle[4]) / 3
  ); // HLC average

  // Calculate SMA if prevEMA is not provided
  let ema: number;
  if (prevEMA === null) {
    const sma = hlcValues.reduce((acc, val) => acc + val, 0) / period;
    ema = sma;
  } else {
    ema = prevEMA;
  }

  // Calculate EMA only for the latest candle
  const latestHLC = hlcValues[hlcValues.length - 1]; // Use the last HLC value
  ema = (latestHLC - ema) * multiplier + ema;

  return {
    ema: Math.round(ema),
    highestHigh,
    lowestLow,
    lastClose,
  };
};
