/// <reference lib="deno.ns" />
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import {Order} from '../../utils/types.ts';

const KITE_API_KEY = Deno.env.get("KITE_API_KEY")!;
const supabaseUrl =Deno.env.get("LOCAL_DEV_SUPABASE_URL") ??Deno.env.get("SUPABASE_URL")!
const supabaseServiceRoleKey =
Deno.env.get("LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY")??Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") !

const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
);


serve(async () => {
  console.log('Connected to Supabase URL:', supabaseUrl);
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
  const response = await fetch("https://api.kite.trade/orders", {
    headers: {
      Authorization: `token ${KITE_API_KEY}:${accessToken}`,
      "X-Kite-Version": "3",
    },
  });
  if (!response.ok) {
    console.error(
      `Failed to fetch orders`,
    );
    console.error(
      `Response status: ${response.status} and error is ${await response.text()}`,
    );
    return new Response('Failed to fetch orders', { status: 500 });
  }
  const { data } = await response.json();
  if (!data || data.length === 0) {
    console.error(`No orders found`);
    return new Response('No orders found', { status: 500 });
  }
  console.log('Orders:', data);
  const results = data.filter((order: Order) => order.status === 'COMPLETE').map((order: Order) => ({
    order_id: order.order_id,
    tradingsymbol: order.tradingsymbol, 
    order_timestamp: order.order_timestamp,
    variety: order.variety,
    exchange: order.exchange,
    instrument_token: order.instrument_token,
    transaction_type: order.transaction_type,
    average_price: order.average_price,
    quantity: order.quantity,
    product: order.product,
    tag: order.tag})
    );

  if (results.length > 0) {
    const { error: insertError } = await supabase.from('transactions').insert(results);
    if (insertError) {
      console.error('Insert failed', insertError);
      return new Response('Insert into transactions failed', { status: 500 });
    }

    return new Response(' Insert into transactions complete', { status: 200 });
  }

  return new Response('No inserts done', { status: 200 });
});
