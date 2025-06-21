// supabase/functions/insertAccessToken/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { toISTString } from "../../utils/dateUtils.ts"; // your utility function
import { fetchInstruments } from "../../utils/kiteUtils.ts"; // your utility function

// Supabase environment variables
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);


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
   {   
      const rowsToInsert=await fetchInstruments(access_token);
      if (!rowsToInsert || rowsToInsert.length === 0) {
        console.error("No instruments found");
        return new Response(JSON.stringify({ error: "No instruments found" }), { status: 404 });
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
