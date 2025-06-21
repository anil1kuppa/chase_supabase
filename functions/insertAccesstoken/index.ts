// supabase/functions/insertAccessToken/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { toISTString } from "../../utils/dateUtils.ts"; // your utility function
import Papa from 'https://esm.sh/papaparse@5.4.1'

// Supabase environment variables
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const KITE_API_KEY = Deno.env.get("KITE_API_KEY")!;
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const fetchInstruments = async (access_token: string) => {
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
    return;
  }

   // 5️⃣ Insert into Supabase
   const { error } = await supabase
     .from('instruments')
     .upsert(rowsToInsert, { onConflict: 'instrument_token', ignoreDuplicates: true })

   if (error) {
     console.error('Insert error:', error)
     throw new Error(`Error inserting records: ${error.message}`);
  }

  console.log(`Inserted ${rowsToInsert.length} instruments`)
}

serve(async (req) => {
  try {
    const { access_token } = await req.json();
    if (!access_token) {
      return new Response(JSON.stringify({ error: "access_token is required" }), { status: 400 });
    }

    // Convert current date to IST
    const istDateStr = toISTString(new Date());
    
    // Insert record
    const { error } = await supabase.from("accesstoken").insert({
      access_token,
      created_at: istDateStr,
    });

    if (error) {
      console.error("Insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    console.log("Access token inserted successfully:", access_token);
    const { data, error: cleanupError } = await supabase.rpc('cleanup_old_records')

    if (cleanupError) {
      console.error('Error running cleanup:', cleanupError)
      return new Response(JSON.stringify({ error: cleanupError.message }), { status: 500 })
    }
    console.log('Cleanup function executed successfully:', data)
    // Fetch instruments
   try
   {   await fetchInstruments(access_token);
   }
   catch (fetchError) {
      console.error("Error fetching instruments:", fetchError);
      return new Response(JSON.stringify({ error: "Failed to fetch instruments" }), { status: 500 });
    }
    return new Response(JSON.stringify({ message: "Access token inserted successfully" }), { status: 200 });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});
