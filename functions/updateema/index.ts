/// <reference lib="deno.ns" />
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { toISTString } from '../../utils/dateUtils.ts';
import { CHASE_STATUS, Instrument } from '../../utils/types.ts';
import { postToSlack } from '../../utils/slackMessage.ts';
import { getChaseStatus, updateChaseStatus } from '../../utils/supabase.ts';
import {calculate40EMA,getHistoricalCandles} from '../../utils/emaCalculator.ts';

const supabaseUrl =Deno.env.get("LOCAL_DEV_SUPABASE_URL") ??Deno.env.get("SUPABASE_URL")!
const supabaseServiceRoleKey =
Deno.env.get("LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY")??Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") !

const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
);

/*
export const calculate40EMA = (
  candles: Array<[string, number, number, number, number, number]>, // Array of arrays
  prevEMA: number | null = null,
  date: string,
):
  | { ema: number; highestHigh: number; lowestLow: number; lastClose: number }
  | null => {
  const period = 40;
  const multiplier = 2 / (period + 1);

  // Filter candles for the given date
  const filteredCandles = candles.filter((candle) =>
    candle[0].startsWith(date)
  );
  if (filteredCandles.length === 0) {
    console.error(`No candles found for the date: ${date}`);
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
  const recentCandles = candles.slice(-period);
  const hlcValues = recentCandles.map((candle) =>
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
*/
const generateSignal = async (
  instruments: Array<Instrument>,
  todaysDate: string,
): Promise<void> => {
  let current_status: string = '';
  let tradingsymbol: string = '';
  let instrument: Instrument;
  let stoploss: number = 0;
  let is_signal_breaching_tolerance: boolean = false;
  let created_at: string = '';
  const chaseStatusData = await getChaseStatus();
  if (!chaseStatusData) {
    console.error('No chase status data found');
    return;
  }
  console.log(`Chase status data: ${JSON.stringify(chaseStatusData)},todaysDate: ${todaysDate}`);
     ({
      current_status,
      tradingsymbol,
      stoploss,
      is_signal_breaching_tolerance,
      created_at
    } = chaseStatusData);

  if (!instruments || instruments.length === 0) {
    console.error('No instruments found');
    return;
  } else if (instruments.length === 1) {
    instrument = instruments[0];
  } else {
    instrument = instruments[1];
  }
  const [currentDate, timePart] = todaysDate.split(' '); // HH:mm:ss
  const createdat_date = created_at.split('T')[0];
  const hourStr = timePart.split(':')[0];
  const hour = parseInt(hourStr);

  if (
    (current_status === CHASE_STATUS.LONG ||
      current_status === CHASE_STATUS.SHORT) && hour != 13
  ) {
    console.log('Chase is already long or short, no new signal');
  } else if (
    (current_status === CHASE_STATUS.LONG ||
      current_status === CHASE_STATUS.SHORT) &&
    hour === 13 &&
    (createdat_date !== currentDate)
  ) {
    instrument = instruments.find((instrument) =>
      instrument.tradingsymbol === tradingsymbol
    )!;
    stoploss=current_status === CHASE_STATUS.LONG ?Math.max(instrument.ema!, stoploss):Math.min(instrument.ema!, stoploss);
    console.log(`Chase is long or short,updating the SL to ${stoploss}`);
    await postToSlack(
      `Action $chase: Chase is currently ${current_status}, update the stoploss to ${stoploss}  for symbol:${instrument.tradingsymbol}`
    );
    // Update the chase_status table with the new stoploss and status
    const { success, error } = await updateChaseStatus({
      stoploss: stoploss,
      last_modified_at: todaysDate
    })
    if (success) {
      console.log('Chase status updated successfully:');
    } 
    else {
      console.error('Error updating chase_status:', error);
      return;
    }
  } 
  else if (current_status === CHASE_STATUS.AWAITING_SIGNAL ) 
 {
    const longTolerance: number = instrument?.ema ? 1.02 * instrument.ema : 0;
    const shortTolerance: number = instrument?.ema ? 0.98 * instrument.ema : 0;

    console.log('Chase is awaiting signal');
    if ((instrument?.last_close ?? 0) > longTolerance) {
      stoploss = Math.round(
        Math.min(
          instrument?.ema ? instrument?.ema : 0,
          instrument.lowest_low ? instrument.lowest_low : 0,
        ),
      );
      await postToSlack(`Action $chase: Chase is AWAITING_LONG.
                             Enter on crossing ${instrument.highest_high} for symbol:${instrument.tradingsymbol}, stoploss ${stoploss}`);

      // Update the chase_status table with the new stoploss and status
      const { success, error } = await updateChaseStatus({
        stoploss: stoploss,
        last_modified_at: todaysDate,
        created_at: todaysDate,
        entry_point: instrument.highest_high,
        current_status: CHASE_STATUS.AWAITING_LONG,
        tradingsymbol: instrument.tradingsymbol,
        instrument_token: instrument.instrument_token,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } 
      else {
        console.error('Error updating chase_status:', error);
        return;
      }
    } 
    else if ((instrument?.last_close ?? 0) < shortTolerance) 
      {
      stoploss = Math.round(
        Math.max(
          instrument?.ema ? instrument?.ema : 0,
          instrument.highest_high ? instrument.highest_high : 0,
        ),
      );
      await postToSlack(`Action $chase: Chase is AWAITING_SHORT.
                             Enter on crossing ${instrument.lowest_low} for symbol:${instrument.tradingsymbol}, stoploss ${stoploss}`);
      // Update the chase_status table with the new stoploss and status
      const { success, error } = await updateChaseStatus({
        stoploss: stoploss,
        last_modified_at: todaysDate,
        created_at: todaysDate,
        entry_point: instrument.lowest_low,
        current_status: CHASE_STATUS.AWAITING_SHORT,
        tradingsymbol: instrument.tradingsymbol,
        instrument_token: instrument.instrument_token,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } else {
        console.error('Error updating chase_status:', error);
        return;
      }
    } 
    else {
      await postToSlack(`Entry Signal Not Found. Chase is AwaitingSignal`);
    }
  } 
  else if (
    (current_status === CHASE_STATUS.AWAITING_LONG ||
      current_status === CHASE_STATUS.AWAITING_SHORT)
  ) 
  {
    instrument = instruments.find((instrument) =>
      instrument.tradingsymbol === tradingsymbol
    )!;
    console.log('Validating if the singal is valid');
    const longTolerance: number = instrument?.ema ? 1.02 * instrument.ema : 0;
    const shortTolerance: number = instrument?.ema ? 0.98 * instrument.ema : 0;

    if (
      current_status === CHASE_STATUS.AWAITING_LONG &&
      (instrument.last_close! < stoploss || is_signal_breaching_tolerance))
    {
      await postToSlack(
        `Action $chase: Signal Invalid . Chase is now AwaitingSignal`,
      );
      const { success, error } = await updateChaseStatus({
        last_modified_at: todaysDate,
        created_at: todaysDate,
        current_status: CHASE_STATUS.AWAITING_SIGNAL,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } else {
        console.error('Error updating chase_status:', error);
        return;
      }
    } 
    else if (
      current_status === CHASE_STATUS.AWAITING_LONG &&
      instrument.last_close! < shortTolerance) 
    {
      console.log(
        'Chase is still awaiting long, but last close is less than short tolerance',
      );
      const { success, error } = await updateChaseStatus({
        last_modified_at: todaysDate,
        is_signal_breaching_tolerance: true,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } 
      else {
        console.error('Error updating chase_status:', error);
        return;
      }
    }
    else if (
      current_status === CHASE_STATUS.AWAITING_SHORT &&
      (instrument.last_close! > stoploss || is_signal_breaching_tolerance) )
    {
      await postToSlack(
        `Action $chase: Signal Invalid . Chase is now AwaitingSignal`,
      );
      const { success, error } = await updateChaseStatus({
        last_modified_at: todaysDate,
        created_at: todaysDate,
        current_status: CHASE_STATUS.AWAITING_SIGNAL,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } else {
        console.error('Error updating chase_status:', error);
        return;
      }
    } 
    else if (
      current_status === CHASE_STATUS.AWAITING_SHORT &&
      instrument.last_close! > longTolerance) 
    {
      console.log(
        'ChaSe is still awaiting short, but last close is greater than long tolerance',
      );
      const { success, error } = await updateChaseStatus({
        is_signal_breaching_tolerance: true,
        last_modified_at: todaysDate,
      });
      if (success) {
        console.log('Chase status updated successfully:');
      } else {
        console.error('Error updating chase_status:', error);
        return;
      }
    }
    else if (
     hour ===15)
     {
        console.log(`Cancelling the signal as it's EOD`);
        const { success, error } = await updateChaseStatus({
          last_modified_at: todaysDate,
          created_at: todaysDate,
          current_status: CHASE_STATUS.AWAITING_SIGNAL,
          is_signal_breaching_tolerance: false,
        });
        if (success) {
          console.log('Chase status updated successfully:');
        } else {
          console.error('Error updating chase_status:', error);
          return;
     } 
    }
  }
};

serve(async () => {
  console.log('Connected to Supabase URL:', supabaseUrl);
  console.log(`supabase url: ${Deno.env.get("SUPABASE_URL")}`);
  // Step 1: Get the latest access token for today

  const { data: accessToken, error } = await supabase.rpc('get_latest_token');

  if (error) {
    console.error(error);
  } else {
    console.log('Latest token:', accessToken);
  }

  if (error || !accessToken) {
    return new Response('No access token found for today', { status: 400 });
  }

  // Step 2: Get instruments and existing EMA
  const { data: instruments, error: instrumentsError } = await supabase
    .from('expiry_instruments_with_ema')
    .select('instrument_token, tradingsymbol,ema,expiry_date')
    .order('expiry_date', { ascending: true });

  if (instrumentsError || !instruments) {
    return new Response('Failed to fetch instruments', { status: 500 });
  }
  console.log('Instruments:', instruments);
  const now = new Date();

  const to = toISTString(now);

  // Step 3: For each instrument, call Kite historical API and calculate 40 EMA
  const results = await Promise.all(
    (instruments as Array<Instrument>).map(async (instrument) => {
      const prevEMA = instrument.ema;

      const candles = await getHistoricalCandles(
        instrument,
        '60minute',
        12 * 24 * 60 * 60 * 1000,
        accessToken,
      );
      if (!candles || candles.length < 40) {
        console.error(`Not enough data for ${instrument.tradingsymbol}`);
        return null;
      }

      const result = calculate40EMA(candles, prevEMA);

      if (result) {
        const { ema, highestHigh, lowestLow, lastClose } = result;
        console.log(`Calculated EMA for ${instrument.tradingsymbol}:`, ema);
        instrument.ema = ema;
        instrument.highest_high = highestHigh;
        instrument.lowest_low = lowestLow;
        instrument.created_at = to;
        instrument.last_close = lastClose;
        return {
          tradingsymbol: instrument.tradingsymbol,
          instrument_token: instrument.instrument_token,
          ema: ema,
          highest_high: highestHigh,
          lowest_low: lowestLow,
          created_at: to,
          last_close: lastClose
        };
      } else {
        console.error('calculate40EMA returned null');
        return null;
      }
    }),
  );

  // Step 4: Insert into ema table
  const inserts = results.filter((r) => r !== null);
  console.log('Inserts:', inserts);
  console.log('instruments are', instruments);

  if (inserts.length > 0) {
    const { error: insertError } = await supabase.from('ema').insert(inserts);
    if (insertError) {
      console.error('Insert failed', insertError);
      return new Response('EMA insert failed', { status: 500 });
    }
    //generate signal
    await generateSignal(instruments, to);
    console.log('Generated signal');
    return new Response('EMA Insert complete', { status: 200 });
  }

  return new Response('No inserts done', { status: 200 });
});
