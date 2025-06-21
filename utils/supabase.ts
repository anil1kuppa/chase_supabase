
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const supabaseUrl =Deno.env.get("LOCAL_DEV_SUPABASE_URL") ??Deno.env.get("SUPABASE_URL")!
const supabaseServiceRoleKey =
Deno.env.get("LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY")?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") !


const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey
);

export const getChaseStatus = async () => {
    const { data: chaseStatusData, error: chaseStatusError } = await supabase
        .from("chase_status")
        .select("current_status, tradingsymbol, stoploss, created_at,is_signal_breaching_tolerance,entry_point, instrument_token")
        .order("created_at", { ascending: false })
        .single(); // Ensures only one row is fetched

    if (chaseStatusError) {
        console.error("Error fetching chase_status:", chaseStatusError);
        return null;
    }

    return chaseStatusData || null;
};

export const updateChaseStatus = 
    async (fields: { current_status?: string; tradingsymbol?: string; stoploss?: number,
        created_at?:string,last_modified_at?:string,
         instrument_token?:number,entry_point?:number,is_signal_breaching_tolerance?:boolean}) => {
    const { error } = await supabase
        .from("chase_status")
        .update(fields)
        .eq("id", 1); // Assuming you want to update the row with id = 1;

    if (error) {
        console.error("Error updating chase_status:", error);
        return { success: false, error };
    }

    return { success: true, message: "Chase status updated successfully" };
};

export async function getPreviousTradingDay(date = null) {
    try {
      const targetDate = date ? new Date(date).toISOString() : new Date().toISOString()
      
      const { data, error } = await supabase
        .rpc('get_previous_trading_day', { 
          target_date: targetDate 
        })
      
      if (error) throw error
      return data  // Returns the date in YYYY-MM-DD format
    } catch (error) {
      console.error('Error getting previous trading day:', error)
      return null
    }
  }