/// <reference lib="deno.ns" />
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { toISTString } from '../../utils/dateUtils.ts';
import { Candle, CHASE_STATUS, Instrument, TRANSACTION_TYPE } from '../../utils/types.ts';
import { postToSlack } from '../../utils/slackMessage.ts';
import { getChaseStatus, updateChaseStatus,getUserConfig } from '../../utils/supabaseUtils.ts';
import {calculate40EMA,cancelOrder,getHistoricalCandles, placeKiteOrder, placeSL} from '../../utils/kiteUtils.ts';

const supabaseUrl =Deno.env.get("LOCAL_DEV_SUPABASE_URL") ??Deno.env.get("SUPABASE_URL")!
const supabaseServiceRoleKey =
Deno.env.get("LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY")??Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") !

const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
);

const generateSignal = async (
  accessToken: string,
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
      `:shield: Action $chase: Chase is currently ${current_status}, update the stoploss to ${stoploss}  for symbol:${instrument.tradingsymbol}`
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
    const userConfig = await getUserConfig();
    if (!userConfig) {
      console.error('Failed to fetch user config');
      return;
    }
    if (userConfig.is_chase_automated) {
      await placeSL(
        instrument.tradingsymbol!,
        current_status === CHASE_STATUS.LONG ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY,
        userConfig.chase_quantity,
        accessToken,
        stoploss);
      console.log(`Order modified for ${instrument.tradingsymbol}`);
    }
  } 
  else if (current_status === CHASE_STATUS.AWAITING_SIGNAL ) 
 {
    const longTolerance: number = instrument?.ema ? 1.002 * instrument.ema : 0;
    const shortTolerance: number = instrument?.ema ? 0.998 * instrument.ema : 0;

    console.log(`Chase is awaiting signal; longTolerance=${longTolerance}, shortTolerance=${shortTolerance}`);
    if ((instrument?.last_close ?? 0) > longTolerance) {
      stoploss = Math.round(
        Math.min(
          instrument?.ema ? instrument?.ema : 0,
          instrument.lowest_low ? instrument.lowest_low : 0,
        ),
      );
      await postToSlack(`:rocket: Action $chase: Chase is AWAITING_LONG. 🚀 Enter on crossing ${instrument.highest_high} for symbol: ${instrument.tradingsymbol}, stoploss ${stoploss} :shield:`);

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
      const userConfig = await getUserConfig();
      if (!userConfig) {
        console.error('Failed to fetch user config');
        return;
        }
      if (userConfig.is_chase_automated) {
        await placeKiteOrder(accessToken, {
          tradingsymbol: instrument.tradingsymbol,
          transaction_type: 'BUY',
          quantity: userConfig.chase_quantity,
          exchange:'NFO',
          order_type: 'SL',
          product: 'NRML',
          tag: 'chase',
          trigger_price: instrument.highest_high,
          price: instrument.highest_high!+5, 
        });
        console.log(`Placed buy order for ${instrument.tradingsymbol} with triggerprice ${instrument.highest_high}`);
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
      await postToSlack(`:rotating_light: Action $chase: Chase is AWAITING_SHORT. 🔻 Enter on crossing ${instrument.lowest_low} for symbol: ${instrument.tradingsymbol}, stoploss ${stoploss} :shield:`);
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
      const userConfig = await getUserConfig();
      if (!userConfig) {
        console.error('Failed to fetch user config');
        return;
        }
      if (userConfig.is_chase_automated) {
        await placeKiteOrder(accessToken, {
          tradingsymbol: instrument.tradingsymbol,
          transaction_type: 'SELL',
          quantity: userConfig.chase_quantity,
          order_type: 'SL',
          exchange:'NFO',
          product: 'NRML',
          tag: 'chase',
          trigger_price: instrument.lowest_low,
          price: instrument.lowest_low!-5
        });
        console.log(`Placed sell order for ${instrument.tradingsymbol} with triggerprice ${instrument.lowest_low}`);
      }
    } 
    else if (hour!== 16){
      await postToSlack(`:grey_question: Entry Signal Not Found. :hourglass_flowing_sand: Chase is AwaitingSignal`);
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
    console.log(`Validating if the signal if it's valid`);
    const longTolerance: number = instrument?.ema ? 1.002 * instrument.ema : 0;
    const shortTolerance: number = instrument?.ema ? 0.998 * instrument.ema : 0;
    if (hour ===16)
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
    else if (
      current_status === CHASE_STATUS.AWAITING_LONG &&
      (instrument.last_close! < stoploss || is_signal_breaching_tolerance))
    {
      await postToSlack(
        `:x: Action $chase: Signal Invalid. :no_entry_sign: Chase is now AwaitingSignal :hourglass_flowing_sand:`
      );
    
      const { success, error } = await updateChaseStatus({
        last_modified_at: todaysDate,
        created_at: todaysDate,
        current_status: CHASE_STATUS.AWAITING_SIGNAL,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
        const userConfig = await getUserConfig();
        if (!userConfig) {
        console.error('Failed to fetch user config');
        return;
        }
        if (userConfig.is_chase_automated) {
        await cancelOrder(instrument.tradingsymbol,TRANSACTION_TYPE.BUY,accessToken);
        console.log(`Order cancelled for ${instrument.tradingsymbol}`);
        }
        await generateSignal(accessToken,instruments, todaysDate);
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
        `:x: Action $chase: Signal Invalid. :no_entry_sign: Chase is now AwaitingSignal :hourglass_flowing_sand:`
      );
      const { success, error } = await updateChaseStatus({
        last_modified_at: todaysDate,
        created_at: todaysDate,
        current_status: CHASE_STATUS.AWAITING_SIGNAL,
        is_signal_breaching_tolerance: false,
      });
      if (success) {
        console.log('Chase status updated successfully:');
        const userConfig = await getUserConfig();
        if (!userConfig) {
        console.error('Failed to fetch user config');
        return;
        }
        if (userConfig.is_chase_automated) {
        await cancelOrder(instrument.tradingsymbol,TRANSACTION_TYPE.SELL,accessToken);
        console.log(`Order cancelled for ${instrument.tradingsymbol}`);
        }
        await generateSignal(accessToken,instruments, todaysDate);
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
  }
};

serve(async () => {
  console.log('Connected to Supabase URL:', supabaseUrl);
  // Step 1: Get the latest access token for today

  const { data: accessToken, error } = await supabase.rpc('get_latest_token');

  if (error) {
    console.error(error);
  };

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
  const now = new Date();

  const to = toISTString(now);

  // Step 3: For each instrument, call Kite historical API and calculate 40 EMA
  const results = await Promise.all(
    (instruments as Array<Instrument>).map(async (instrument) => {
      const prevEMA = instrument.ema;
      let candles: Array<Candle> | null = null;
      if (!prevEMA) {
          candles = await getHistoricalCandles(
        instrument,
        '60minute',
        90 * 24 * 60 * 60 * 1000,
        accessToken,
      );
      }
      else
      {
        candles = await getHistoricalCandles(
        instrument,
        '60minute',
        1 * 24 * 60 * 60 * 1000,
        accessToken,
      );
    }
      if (!candles ) {
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
    await generateSignal(accessToken,instruments, to);
    console.log('Generated signal');
    return new Response('EMA Insert complete', { status: 200 });
  }

  return new Response('No inserts done', { status: 200 });
});
