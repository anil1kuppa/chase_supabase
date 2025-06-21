export interface Instrument {
    instrument_token: number;
    tradingsymbol: string;
    ema?: number; // Optional, as it may not always be present
    expiry_date?: string; // Format: YYYY-MM-DD
    highest_high?: number; // Optional, calculated later
    lowest_low?: number; // Optional, calculated later
    last_close?: number; // Optional, calculated later
    created_at?: string; // Format: YYYY-MM-DD
  }
  //Add enum for different chase statuses
  export enum CHASE_STATUS {
    AWAITING_LONG = "AWAITING_LONG",
    AWAITING_SHORT = "AWAITING_SHORT",
    LONG = "LONG",
    SHORT = "SHORT",
    AWAITING_SIGNAL = "AWAITING_SIGNAL"
  }
  export enum TRANSACTION_TYPE {
    BUY = "BUY",
    SELL = "SELL"
  }

    export enum KITE_ORDER_STATUS {
    TRIGGER_PENDING = "TRIGGER PENDING",
    COMPLETE = "COMPLETE",
    CANCELLED="CANCELLED"
  }

  export type Candle = [string, number, number, number, number, number]; 
  // Example: [timestamp, open, high, low, close, volume]
  //  "2025-04-16T09:15:00+0530",
  // 23337.9,
  // 23338,
  // 23287.7,
  // 23295,
  // 282225
  export  interface Order {
    order_id: string;
    tradingsymbol: string;
    order_timestamp: string; // "2023-01-06 09:18:24",
    variety: string;
    exchange: string;
    instrument_token: number;
    transaction_type: string;
    average_price: number;
    quantity: number;
    product: string;
    tag: string;
    status: string;
    placed_by: string;
    exchange_order_id: string;
    parent_order_id: string|null
    status_message: string|null;
    exchange_update_timestamp: string;
    exchange_timestamp: string;
    modified: string;
    order_type: string;
    validity: string;
    validity_ttl:number
    disclosed_quantity:number
    trigger_price:number
    filled_quantity:number
    pending_quantity:number
    cancelled_quantity:number
    market_protection:number
    [key: string]: any; // or 'unknown'
    tags: string[]; // Assuming tags is an array of strings
  }
  

  export type KiteOrderParams = {
  tradingsymbol?: string;
  exchange?: "NSE" | "BSE" | "MCX" | "NFO" | "CDS";
  transaction_type?: "BUY" | "SELL";
  order_type?: "MARKET" | "LIMIT" | "SL" | "SL-M";
  quantity?: number;
  product?: "MIS" | "CNC" | "NRML";
  tag?: string;
  price?: number;
  trigger_price?: number;
  // Add other optional fields as needed
};


