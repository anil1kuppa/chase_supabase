Promise<{
    candles: Array<[timestamp: string, open: number, high: number, low: number, close: number, volume: number]>,
    highestHigh: number,
    lowestLow: number,
    lastClose: number
  } | null>