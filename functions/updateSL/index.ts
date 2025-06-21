import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { toISTString } from '../../utils/dateUtils.ts';
import {
  calculate40EMA,
  getHistoricalCandles,
} from '../../utils/emaCalculator.ts';
import {
  getChaseStatus,
  getPreviousTradingDay,
  updateChaseStatus,
} from '../../utils/supabase.ts';
import { CHASE_STATUS, Instrument } from '../../utils/types.ts';
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
    const closeMinutes = 15 * 60 + 30; // 15:30

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
    } else {
      console.log('Latest token:', accessToken);
    }

    if (error || !accessToken) {
      return new Response('No access token found for today', { status: 400 });
    }
    if (
      (current_status === CHASE_STATUS.SHORT ||
        current_status === CHASE_STATUS.LONG) && openMinutes === currentMinutes
    ) {
      const { data: instruments, error: instrumentsError } = await supabase
        .from('ema')
        .select(
          'instrument_token, tradingsymbol,ema,highest_high,lowest_low',
        )
        .eq('tradingsymbol', tradingsymbol)
        .order('created_at', { ascending: false })
        .limit(1) // Limit to the latest entry
        .single(); // Ensures only one row is fetched
      if (!instruments) {
        if (instrumentsError || !instruments) {
          return new Response('Failed to fetch instruments', { status: 500 });
        }
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
        '60minute',
        12 * 24 * 60 * 60 * 1000,
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
      const { ema,lastClose,lowestLow,highestHigh } = result;
      const longSignalT1Tolerance = Math.round(1.004 * ema);
      const shortSignalT1Tolerance =Math.round( 0.996 * ema);

      if (
        current_status === CHASE_STATUS.LONG &&
        previousTradingDay === chaseStatusData.created_at.split('T')[0]
      ) {
          if (lastClose > longSignalT1Tolerance)
             {
          stoploss = ema;
          console.log(`Update SL for ${instrument.tradingsymbol} to ${ema}`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
             }
          else if (ema < lastClose && lastClose < longSignalT1Tolerance)
             {
          stoploss = Math.round((instrument.lowest_low! + ema) / 2);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss}`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
             } 
          else if (lastClose < shortSignalT1Tolerance) 
            {
              console.log(`Exit ${instrument.tradingsymbol} at CMP as lastClose is less than shortSignalT1`);
              await postToSlack(
                `Action $chase: Exit ${instrument.tradingsymbol} AT CMP`,
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
              console.log('Chase status updated successfully:');
              //Update SL in chase_status table
              return new Response(
                JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
                { status: 200 },
              );
            }
            else if (shortSignalT1Tolerance < lastClose && lastClose < ema)
            {
              stoploss = lowestLow;
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} where shortSignalT1 is less than lastclose`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
            }

        } 
        else if (
            (current_status === CHASE_STATUS.SHORT ||
              current_status === CHASE_STATUS.LONG) &&
            previousTradingDay !== chaseStatusData.created_at.split('T')[0])
          {
            stoploss = ema;
            console.log(`Update SL for ${instrument.tradingsymbol} to ${ema}`);
            await postToSlack(
              `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
              );
              const { success, error} = await updateChaseStatus({
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
            return new Response(
              JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
              { status: 200 },
            );
      } 
      else if (
        current_status === CHASE_STATUS.SHORT &&
        previousTradingDay === chaseStatusData.created_at.split('T')[0])
      {
        if (lastClose < shortSignalT1Tolerance) {
          stoploss = ema;
          console.log(`Update SL for ${instrument.tradingsymbol} to ${ema}`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } else if (ema > lastClose && lastClose > shortSignalT1Tolerance) {
          stoploss = Math.round((instrument.highest_high! + ema) / 2);
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss}`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (longSignalT1Tolerance > lastClose && lastClose > ema) {
          stoploss = highestHigh;
          console.log(`Update SL for ${instrument.tradingsymbol} to ${stoploss} as longsingalt1 is greater than lastClose`);
          await postToSlack(
            `Action $chase: Update SL for ${instrument.tradingsymbol} to ${stoploss}`,
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
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        } 
        else if (lastClose > longSignalT1Tolerance) {
          console.log(`Exit ${instrument.tradingsymbol} at CMP`);
          await postToSlack(
            `Action $chase: Exit ${instrument.tradingsymbol} AT CMP`,
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
          console.log('Chase status updated successfully:');
          //Update SL in chase_status table
          return new Response(
            JSON.stringify({ signal: 'UPDATED_SL', sl: stoploss }),
            { status: 200 },
          );
        }
      }
    } else if (
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
            `Transaction alert exit_short. Chase is now Awaiting Signal`,
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
          console.log('Chase status updated successfully:');
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        } else if (current_status === CHASE_STATUS.LONG && candle[3] < stoploss) {
          console.log(
            `Stoploss breached for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(
            `Transaction alert exit_long. Chase is now Awaiting Signal`,
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
          console.log('Chase status updated successfully:');
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        } else if (
          current_status === CHASE_STATUS.AWAITING_LONG && candle[2] > entry_point
        ) {
          console.log(
            `TRANSACTION entered for long for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(`Transaction Alert enter_long . Chase is now Long`);
          const { success, error} = await updateChaseStatus({
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
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        } else if (
          current_status === CHASE_STATUS.AWAITING_SHORT && candle[3] < entry_point
        ) {
          console.log(
            `TRANSACTION entered for short for ${instrument.tradingsymbol} at ${candle[0]}`,
          );
          await postToSlack(`Transaction Alert enter_SHORT . Chase is now Short`);
          const { success, error } = await updateChaseStatus({
            current_status: CHASE_STATUS.SHORT,
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
          return new Response(
            JSON.stringify({ signal: 'TRANSACTION_ALERT', sl: stoploss }),
            { status: 200 },
          );
        }
      }
    }

    // Default case if no conditions are met
    console.log('No action taken');
    return new Response(JSON.stringify({ message: 'No action taken' }), {
      status: 200,
    });
  }
  catch (error) {
    console.error('Error in updateSL function:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500 },
    );
  }
});