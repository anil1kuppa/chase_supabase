import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { toISTString } from '../../utils/dateUtils.ts';
import {
  calculate40EMA,
  getHistoricalCandles,getLTP,
  placeSL,
  rollOver} from '../../utils/kiteUtils.ts';
import {
  getChaseStatus,
  getPreviousTradingDay,
  updateChaseStatus,insertIntoChaseLog,getUserConfig
} from '../../utils/supabaseUtils.ts';
import { CHASE_STATUS, Instrument,TRANSACTION_TYPE } from '../../utils/types.ts';
import { postToSlack } from '../../utils/slackMessage.ts';

const supabaseUrl =Deno.env.get("LOCAL_DEV_SUPABASE_URL") ??Deno.env.get("SUPABASE_URL")!
const supabaseServiceRoleKey =
Deno.env.get("LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY")??Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") !


const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
);

serve(async (_req) => {
  try {
    let current_status = '';
    let tradingsymbol: string = '';
    let stoploss: number = 0;
    let instrument_token: number = 0;
    let entry_point: number = 0;
    let instrument: Instrument;
    // Get IST datetime string
    const now = new Date();
    const istDateStr = toISTString(now); // format: YYYY-MM-DD HH:mm:ss

    // Extract HH:mm
    const timePart = istDateStr.split(' ')[1]; // HH:mm:ss
    const [hourStr, minuteStr] = timePart.split(':');
    const hour = parseInt(hourStr);
    const minute = parseInt(minuteStr);

    // Compute time in minutes since midnight
    const currentMinutes = hour * 60 + minute;
    const openMinutes = 9 * 60 + 16; // 09:16
    const closeMinutes = 15 * 60 + 29; // 15:29
    const rolloverMinutes = 15 * 60 + 0; // 15:00

    if (currentMinutes < openMinutes || currentMinutes > closeMinutes) {
      return new Response(JSON.stringify({ message: 'Markets are closed' }), {
        status: 200,
      });
    }

    //Step 2: Get the previous trading day
    const previousTradingDay = await getPreviousTradingDay();
    if (!previousTradingDay) {
      return new Response(
        JSON.stringify({ error: 'Failed to get previous trading day' }),
        { status: 500 },
      );
    }
    //Step3: Get the status, entry from chase_status table
    const chaseStatusData = await getChaseStatus();
    if (chaseStatusData) {
      ({
        current_status,
        tradingsymbol,
        stoploss,
        entry_point,
        instrument_token,
      } = chaseStatusData);
      console.log(`Chase status data: ${JSON.stringify(chaseStatusData)}`);
    } else {
      return new Response(
        JSON.stringify({ error: 'Failed to get chase status' }),
        { status: 500 },
      );
    }
    instrument = {
      tradingsymbol: tradingsymbol,
      instrument_token: instrument_token,
    };

    const { data: accessToken, error } = await supabase.rpc('get_latest_token');

    if (error) {
      console.error(error);
    }
    if (error || !accessToken) {
      return new Response('No access token found for today', { status: 400 });
    }
      const { data: instruments, error: instrumentsError } = await supabase
    .from('expiry_instruments_with_ema')
    .select('instrument_token, tradingsymbol,ema,expiry_date,ema')
    .order('expiry_date', { ascending: true });

  if (instrumentsError || !instruments) {
    return new Response('Failed to fetch instruments', { status: 500 });
  }

    
    if (
      (current_status === CHASE_STATUS.SHORT ||
        current_status === CHASE_STATUS.LONG) && openMinutes === currentMinutes ) 
      {
      const { data: instruments, error: instrumentsError } = await supabase
        .from('ema')
        .select(
          'instrument_token, tradingsymbol,ema,highest_high,lowest_low',
        )
        .eq('tradingsymbol', tradingsymbol)
        .order('created_at', { ascending: false })
        .limit(1) // Limit to the latest entry
        .single(); // Ensures only one row is fetched
      
      if (instrumentsError || !instruments) {
        return new Response('Failed to fetch instruments', { status: 500 });
      }
      
      instrument = {
        ema: instruments.ema,
        highest_high: instruments.highest_high,
        lowest_low: instruments.lowest_low,
        instrument_token: instruments.instrument_token,
        tradingsymbol: instruments.tradingsymbol
      };

      const candles = await getHistoricalCandles(
        instrument,
        '2minute',
        2 * 60 * 1000,
        accessToken,
      );

      if (!candles || candles.length === 0) {
        console.error(`No candles found for ${instrument.tradingsymbol}`);
        return new Response(JSON.stringify({ error: 'No candles found' }), {
          status: 404,
        });
      }
      
      const result = calculate40EMA(candles, instrument.ema);
      if (!result) {
        console.error('calculate40EMA returned null');
        return new Response(
          JSON.stringify({ error: 'calculate40EMA returned null' }),
          { status: 500 },
        );
      }
      
      const { ema, lastClose, lowestLow, highestHigh } = result;
      const longSignalT1Tolerance = Math.round(1.004 * ema);
      const shortSignalT1Tolerance = Math.round(0.996 * ema);
      console.log(`EMA: ${ema}, Last Close: ${lastClose}, Long Signal T1: ${longSignalT1Tolerance}, Short Signal T1: ${shortSignalT1Tolerance}`);
      if (
        current_status === CHASE_STATUS.LONG &&
        previousTradingDay === chaseStatusData.created_at.split('T')[0]
      ) {
        if (lastClose >= longSignalT1Tolerance) {
          stoploss = Math.max(stoploss, ema);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${ema} as lastClose>=longSignalT1Tolerance`);
            await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
            );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
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

            
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
      }
        else if (ema <= lastClose && lastClose <= longSignalT1Tolerance) {
          stoploss = Math.max(stoploss, Math.round((instrument.lowest_low! + ema) / 2));
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} as chase is long and lastClose is less than longSignalT1Tolerance`);
          await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
          );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          //Update SL in chase_status table
            const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (lastClose <= shortSignalT1Tolerance) {
          console.log(`Exit ${instrument.tradingsymbol} at CMP as lastClose is less than shortSignalT1`);
          await postToSlack(
            `:rotating_light: Action $chase: Transaction Alert Exit ${instrument.tradingsymbol} AT CMP :stop_sign:`  );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            created_at: istDateStr,
            current_status: CHASE_STATUS.AWAITING_SIGNAL,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.SELL,
            average_price: lastClose,
            created_at:istDateStr
          });
          console.log('Chase status updated successfully:');
          //Update SL in chase_status table
            const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
                    instrument.tradingsymbol!,
                    current_status === CHASE_STATUS.LONG ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY,
                    userConfig.chase_quantity,
                    accessToken,
                    lastClose);
                  console.log(`Order modified for ${instrument.tradingsymbol}`);
          }
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        }
        else if (shortSignalT1Tolerance <= lastClose && lastClose <= ema) {
          stoploss = Math.max(stoploss, lowestLow);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} where shortSignalT1 is less than lastclose`);
            await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
            );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
           const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        }
      } 
      else if (
        (current_status === CHASE_STATUS.SHORT ||
          current_status === CHASE_STATUS.LONG) &&
        previousTradingDay !== chaseStatusData.created_at.split('T')[0]
      ) {
        stoploss = current_status === CHASE_STATUS.LONG?Math.max(stoploss, ema):Math.min(stoploss, ema);
        console.log(`Update SL for ${instrument.tradingsymbol} to ${ema} and previous trading day is not equal to chaseStatusData created_at`);
        await postToSlack(
          `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
        );
        const { success, error } = await updateChaseStatus({
          stoploss: stoploss,
          last_modified_at: istDateStr,
          tradingsymbol: instrument.tradingsymbol,
          instrument_token: instrument.instrument_token,
          is_signal_breaching_tolerance: false,
        });
        if (!success) {
          console.error('Error updating chase_status:', error);
          return new Response(
            JSON.stringify({ error: 'Failed to update chase status' }),
            { status: 500 },
          );
        }
        console.log('Chase status updated successfully:');
         const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
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
        return new Response(
          JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
          { status: 200 },
        );
      } 
      else if (
        current_status === CHASE_STATUS.SHORT &&
        previousTradingDay === chaseStatusData.created_at.split('T')[0]
      ) {
        if (lastClose <= shortSignalT1Tolerance) {
          stoploss = Math.min(stoploss, ema);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${ema} when chase is short and lastClose is less than shortSignalT1`);
          await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
          );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
           const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
                    instrument.tradingsymbol!,
                     TRANSACTION_TYPE.BUY,
                    userConfig.chase_quantity,
                    accessToken,
                    stoploss);
                  console.log(`Order modified for ${instrument.tradingsymbol}`);
          }
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        }
        else if (ema >= lastClose && lastClose >= shortSignalT1Tolerance) {
          stoploss = Math.min(stoploss, Math.round((instrument.highest_high! + ema) / 2));
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} when chase is short and lastClose is greater than shortSignalT1`);
          await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
          );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
                    instrument.tradingsymbol!,
                     TRANSACTION_TYPE.BUY,
                    userConfig.chase_quantity,
                    accessToken,
                    stoploss);
                  console.log(`Order modified for ${instrument.tradingsymbol}`);
          }
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (longSignalT1Tolerance >= lastClose && lastClose >= ema) {
          stoploss = Math.min(stoploss, highestHigh);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} as longsingalt1 is greater than lastClose`);
          await postToSlack(
            `:zap: Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
          );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
                    instrument.tradingsymbol!,
                     TRANSACTION_TYPE.BUY,
                    userConfig.chase_quantity,
                    accessToken,
                    stoploss);
                  console.log(`Order modified for ${instrument.tradingsymbol}`);
          }
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (lastClose >= longSignalT1Tolerance) {
          console.log(`Exit ${instrument.tradingsymbol} at CMP as lastClose is greater than longSignalT1. Chase was SHORT`);
            await postToSlack(
            `:rotating_light: Action $chase: Transaction Alert Exit ${instrument.tradingsymbol} AT CMP :stop_sign:`,
            );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            created_at: istDateStr,
            current_status: CHASE_STATUS.AWAITING_SIGNAL,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.BUY,
            average_price: lastClose,
            created_at: istDateStr
          });
          console.log('Chase status updated successfully:');
          const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
                    instrument.tradingsymbol!,
                     TRANSACTION_TYPE.BUY,
                    userConfig.chase_quantity,
                    accessToken,
                    lastClose);
                  console.log(`Order modified for ${instrument.tradingsymbol}`);
          }
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: lastClose }),
            { status: 200 },
          );
        }
      }
    } 
    else if ( (current_status === CHASE_STATUS.SHORT ||
        current_status === CHASE_STATUS.LONG) && rolloverMinutes === currentMinutes && instruments.length===2
      && instruments[0].tradingsymbol===instrument.tradingsymbol )
        {
          //Rollover to the next month
          console.log('Rolling over to the next month future');
          /*
          1. Get the latest EMA
          2. update the chase status with the new instrument token and tradingsymbol
          3. Post to slack
          */
         instrument = {
            ema: instruments[1].ema,
            instrument_token: instruments[1].instrument_token,
            tradingsymbol: instruments[1].tradingsymbol
          };

          const candles =await getHistoricalCandles(
            instrument,
            '2minute',
            2 * 60 * 1000,
            accessToken);
          if (!candles || candles.length === 0) {
            console.error(`No candles found for ${instrument.tradingsymbol}`);
            return new Response(JSON.stringify({ error: 'No candles found' }), {
              status: 404,
            });
          }
          const result = calculate40EMA(candles, instrument.ema);
          if (!result) {
            console.error('calculate40EMA returned null');
            return new Response(
              JSON.stringify({ error: 'calculate40EMA returned null' }),
              { status: 500 },
            );
          }
          stoploss= result.ema;
          await postToSlack(
          `:repeat: Action $chase:  Transaction Alert,Rollover to :arrow_right: ${instrument.tradingsymbol}, Chase is now *${current_status}* with stoploss: *${stoploss}* :shield:`,
          );
          const { success, error } = await updateChaseStatus({
            stoploss: stoploss,
            last_modified_at: istDateStr,
            tradingsymbol: instrument.tradingsymbol,
            instrument_token: instrument.instrument_token,
            is_signal_breaching_tolerance: false,
            entry_point: result.lastClose,
            created_at: istDateStr
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          const ltp:number= await getLTP("NFO",instruments[0].tradingsymbol, accessToken)
           await insertIntoChaseLog({
            tradingsymbol: instruments[0].tradingsymbol,
            transaction_type: current_status === CHASE_STATUS.SHORT? TRANSACTION_TYPE.BUY: TRANSACTION_TYPE.SELL,
            average_price: ltp,
            created_at: istDateStr
          });
           await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: current_status === CHASE_STATUS.SHORT? TRANSACTION_TYPE.SELL: TRANSACTION_TYPE.BUY,
            average_price: result.lastClose,
            created_at: istDateStr
          });
           const userConfig = await getUserConfig();
            if (!userConfig) {
              console.error('Failed to fetch user config');
              return new Response(
            JSON.stringify({ error: 'Failed to fetch user config' }), 
            { status: 400 }
              );
            }
            if (userConfig.is_chase_automated) {
                await rollOver(
                  [instruments[0].tradingsymbol,instrument.tradingsymbol],
                  accessToken,
                );
                console.log('Chase rolled over successfully:');
                await placeSL(
                instrument.tradingsymbol!,
                current_status === CHASE_STATUS.LONG ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY,
                userConfig.chase_quantity,
                accessToken,
                stoploss);
                console.log(`Order placed for ${instrument.tradingsymbol} with stoploss ${stoploss}`);
              }
          return new Response(
            JSON.stringify({ signal: 'ROLLOVER', sl: stoploss }),
            { status: 200 },
          );

        }
    else if (
      current_status === CHASE_STATUS.SHORT ||
      current_status === CHASE_STATUS.LONG ||
      current_status === CHASE_STATUS.AWAITING_SHORT ||
      current_status === CHASE_STATUS.AWAITING_LONG
    ) {
      const candles = await getHistoricalCandles(
        instrument,
        '2minute',
        2 * 60 * 1000,
        accessToken,
      );
      if (!candles || candles.length === 0) {
        console.error(`No candles found for ${instrument.tradingsymbol}`);
        return new Response(JSON.stringify({ error: 'No candles found' }), {
          status: 404,
        });
      }

      // Check if SL has breached, but adjust to not use forEach which can lead to early returns
      for (const candle of candles) {
        if (current_status === CHASE_STATUS.SHORT && candle[2] > stoploss) {
          console.log(
            `Stoploss breached for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
            await postToSlack(
            `:rotating_light: Transaction alert exit_short. Chase is now Awaiting Signal :hourglass_flowing_sand:`,
            );
          const { success, error } = await updateChaseStatus({
            current_status: CHASE_STATUS.AWAITING_SIGNAL,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.BUY,
            average_price: stoploss,
            created_at: istDateStr
          });
          console.log('Chase status updated successfully:');
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (current_status === CHASE_STATUS.LONG && candle[3] < stoploss) {
          console.log(
            `Stoploss breached for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(
            `:rotating_light: Transaction alert exit_long. Chase is now Awaiting Signal :hourglass_flowing_sand:` );
          const { success, error } = await updateChaseStatus({
            current_status: CHASE_STATUS.AWAITING_SIGNAL,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.SELL,
            average_price: stoploss,
            created_at: istDateStr
          });
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        }
        else if (
          current_status === CHASE_STATUS.AWAITING_LONG && candle[2] > entry_point
        ) {
          console.log(
            `TRANSACTION entered for long for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(`:rocket: Transaction Alert enter_long. Chase is now *Long* :arrow_up:`);
          const { success, error } = await updateChaseStatus({
            current_status: CHASE_STATUS.LONG,
            created_at: istDateStr,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 },
            );
          }
          console.log('Chase status updated successfully:');
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.BUY,
            average_price: entry_point,
            created_at: istDateStr
          });
          const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
              instrument.tradingsymbol!,
              current_status === CHASE_STATUS.AWAITING_LONG ? TRANSACTION_TYPE.SELL : TRANSACTION_TYPE.BUY,
              userConfig.chase_quantity,
              accessToken,
              stoploss);
            console.log(`Order placed for ${instrument.tradingsymbol} with stoploss ${stoploss}`);
          }
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (
          current_status === CHASE_STATUS.AWAITING_SHORT && candle[3] < entry_point
        ) {
          console.log(
            `TRANSACTION entered for short for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(`:rocket: Transaction Alert enter_short. Chase is now *Short* :arrow_down:`);
          const { success, error } = await updateChaseStatus({
            current_status: CHASE_STATUS.SHORT,
            created_at: istDateStr,
            is_signal_breaching_tolerance: false,
          });
          if (!success) {
            console.error('Error updating chase_status:', error);
            return new Response(
              JSON.stringify({ error: 'Failed to update chase status' }),
              { status: 500 }
            );
          }
          await insertIntoChaseLog({
            tradingsymbol: instrument.tradingsymbol,
            transaction_type: TRANSACTION_TYPE.SELL,
            average_price: entry_point,
            created_at: istDateStr
          });
          console.log('Chase status updated successfully:');
           const userConfig = await getUserConfig();
          if (!userConfig) {
            console.error('Failed to fetch user config');
            return new Response(
              JSON.stringify({ error: 'Failed to fetch user config' }),
              { status: 500 },
            );
          }
          if (userConfig.is_chase_automated) {
            await placeSL(
              instrument.tradingsymbol!,
              current_status === CHASE_STATUS.AWAITING_SHORT ? TRANSACTION_TYPE.BUY : TRANSACTION_TYPE.SELL,
              userConfig.chase_quantity,
              accessToken,
              stoploss);
            console.log(`Order placed for ${instrument.tradingsymbol} with stoploss ${stoploss}`);
          }
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        }
      }
      
      // Check end of day condition outside the candle loop
   /*   if ((current_status === CHASE_STATUS.AWAITING_SHORT || current_status === CHASE_STATUS.AWAITING_LONG) 
          && currentMinutes == closeMinutes) {
        console.log(`Cancelling the signal as it's EOD`);
        const { success, error } = await updateChaseStatus({
          last_modified_at: istDateStr,
          created_at: istDateStr,
          current_status: CHASE_STATUS.AWAITING_SIGNAL,
          is_signal_breaching_tolerance: false
        });
        if (success) {
          console.log('Chase status updated successfully to AWAITING_SIGNAL');
          return new Response(
            JSON.stringify({ signal: 'NO_ACTION', sl: stoploss }),
            { status: 200 });
        } else {
          console.error('Error updating chase_status:', error);
          return new Response(
            JSON.stringify({ error: 'Failed to update chase status' }),
            { status: 500 }
          );
        }
      }
        */
    }

  

    // Default case if no conditions are met
    console.log('No action taken');
    return new Response(JSON.stringify({ message: 'No action taken' }), {
      status: 200,
    });
  } catch (error) {
    console.error('Error in updateSL function:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500 },
    );
  }
});