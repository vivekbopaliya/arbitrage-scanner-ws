// index.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { Market } from "@project-serum/serum";
import WebSocket from "ws";

interface BinanceTickerData {
  c: string;
  s: string;
}

interface PairConfig {
  serumMarketAddress: string;
  binanceSymbol: string;
  name: string;
  programId: string;
}

interface PriceDifferenceData {
  binancePrice: number;
  serumPrice: number;
  priceDifference: number;
  percentDifference: string;
  pair: string;
  timestamp: string;
}

class PriceMonitorServer {
  private solanaConnection: Connection | null;
  private markets: Map<string, Market>;
  private binanceWs: WebSocket | null;
  private wss;
  private clients: Set<WebSocket>;
  private lastBinancePrices: Map<string, number>;
  private lastSerumPrices: Map<string, number>;

  private readonly TRADING_PAIRS: PairConfig[] = [
    {
      serumMarketAddress: "CVfYa8RGXnuDBeGmniCcdkBwoLqVxh92xB1JqgRQx3F",
      binanceSymbol: "BTCUSDC",
      name: "BTC/USDC",
      programId: "EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o"
    },
    {
      serumMarketAddress: "H5uzEytiByuXt964KampmuNCurNDwkVVypkym75J2DQW",
      binanceSymbol: "ETHUSDC",
      name: "ETH/USDC",
      programId: "EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o"
    },
    {
      serumMarketAddress: "7xMDbYTCqQEcK2aM9LbetGtNFJpzKdfXzLL5juaLh4GJ",
      binanceSymbol: "SOLUSDC",
      name: "SOL/USDC",
      programId: "EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o"
    },

  ];

  private binanceFeeRate = 0.001;
  private solanaFeeRate = 0.003;
  private profitabilityThreshold = 0.005;

  constructor() {
    this.solanaConnection = null;
    this.markets = new Map();
    this.binanceWs = null;
    this.lastBinancePrices = new Map();
    this.lastSerumPrices = new Map();
    this.wss = new WebSocket.Server({ port: 3001 });
    this.clients = new Set();

    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      console.log("Client connected");
      this.clients.add(ws);

      ws.on("message", (message) => {
        try {
          const parsedMessage = JSON.parse(message.toString());
          if (parsedMessage.method === "SUBSCRIBE") {
            this.handleSubscription(ws, parsedMessage.params);
          }
        } catch (error) {
          console.error("Error parsing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("Client disconnected");
        this.clients.delete(ws);
      });
    });
  }

  private handleSubscription(ws: WebSocket, params: string[]): void {
    if (params.includes("difference.all")) {
      this.sendAllPairData(ws);
    } else {
      params.forEach(param => {
        const [type, pair] = param.split(".");
        if (type === "difference") {
          this.sendSinglePairData(ws, pair);
        }
      });
    }
  }

  private sendSinglePairData(ws: WebSocket, pair: string): void {
    const binancePrice = this.lastBinancePrices.get(pair);
    const serumPrice = this.lastSerumPrices.get(pair);
    
    if (binancePrice && serumPrice) {
      const data = this.calculatePriceDifference(pair, binancePrice, serumPrice);
      ws.send(JSON.stringify(data));
    }
  }

  private sendAllPairData(ws: WebSocket): void {
    const allData = this.getAllPairData();
    ws.send(JSON.stringify({ type: "all", data: allData }));
  }

  private getAllPairData(): PriceDifferenceData[] {
    return this.TRADING_PAIRS.map(pair => {
      const binancePrice = this.lastBinancePrices.get(pair.name);
      const serumPrice = this.lastSerumPrices.get(pair.name);

      if (binancePrice && serumPrice) {
        return this.calculatePriceDifference(pair.name, binancePrice, serumPrice);
      }
      return null;
    }).filter((data): data is PriceDifferenceData => data !== null);
  }

  private calculatePriceDifference(pair: string, binancePrice: number, serumPrice: number): PriceDifferenceData {
    const binancePriceAfterFees = binancePrice * (1 - this.binanceFeeRate);
    const serumPriceAfterFees = serumPrice * (1 - this.solanaFeeRate);
    const priceDifference = binancePriceAfterFees - serumPriceAfterFees;
    const percentDifference = (priceDifference / serumPriceAfterFees) * 100;

    return {
      binancePrice,
      serumPrice,
      priceDifference,
      percentDifference: percentDifference.toFixed(2),
      pair,
      timestamp: new Date().toISOString()
    };
  }

  private startBinanceWebSockets(): void {
    const streams = this.TRADING_PAIRS.map(pair => 
      `${pair.binanceSymbol.toLowerCase()}@ticker`
    ).join('/');
    
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.binanceWs = new WebSocket(wsUrl);

    this.binanceWs.on('open', () => {
      console.log('Connected to Binance WebSocket');
    });

    this.binanceWs.on('message', (data: WebSocket.Data) => {
      const message = JSON.parse(data.toString());
      if (message.data) {
        const ticker = message.data as BinanceTickerData;
        const pair = this.TRADING_PAIRS.find(p => 
          p.binanceSymbol.toLowerCase() === message.stream.split('@')[0]
        );
        
        if (pair) {
          this.lastBinancePrices.set(pair.name, parseFloat(ticker.c));
          this.broadcastPrices();
        }
      }
    });

    this.binanceWs.on('error', (error: Error) => {
      console.error('Binance WebSocket error:', error);
    });

    this.binanceWs.on('close', () => {
      console.log('Binance WebSocket disconnected. Reconnecting...');
      setTimeout(() => this.startBinanceWebSockets(), 5000);
    });
  }

  async initialize(): Promise<void> {
    this.solanaConnection = new Connection(SOLANA_CLUSTER, {
      wsEndpoint: SOLANA_WS_CLUSTER,
      commitment: 'confirmed',
    });

    // Initialize all markets
    for (const pair of this.TRADING_PAIRS) {
      const marketPublicKey = new PublicKey(pair.serumMarketAddress);
      const programId = new PublicKey(pair.programId);

      try {
        const market = await Market.load(
          this.solanaConnection,
          marketPublicKey,
          undefined,
          programId
        );
        this.markets.set(pair.name, market);
        console.log(`Loaded market for ${pair.name}`);
      } catch (error) {
        console.error(`Error loading market for ${pair.name}:`, error);
      }
    }

    this.startBinanceWebSockets();
    await this.startSerumWebSockets();

    // Start periodic Serum price updates
    setInterval(() => this.updateAllSerumPrices(), 1000);

    console.log('WebSocket server running on ws://localhost:3001');
  }

  private async startSerumWebSockets(): Promise<void> {
    try {
      await this.updateAllSerumPrices();
      console.log("Serum WebSocket subscriptions established");
    } catch (error) {
      console.error("Error setting up Serum WebSocket:", error);
      setTimeout(() => this.startSerumWebSockets(), 5000);
    }
  }

  private async updateAllSerumPrices(): Promise<void> {
    if (!this.solanaConnection) return;

    for (const [pairName, market] of this.markets.entries()) {
      try {
        const [bids, asks] = await Promise.all([
          market.loadBids(this.solanaConnection),
          market.loadAsks(this.solanaConnection),
        ]);

        const bestBid = bids.getL2(1)[0]?.[0];
        const bestAsk = asks.getL2(1)[0]?.[0];

        if (bestBid && bestAsk) {
          const midPrice = (bestBid + bestAsk) / 2;
          this.lastSerumPrices.set(pairName, midPrice);
        }
      } catch (error) {
        console.error(`Error updating Serum price for ${pairName}:`, error);
      }
    }

    this.broadcastPrices();
  }

  private broadcastPrices(): void {
    const allData = this.getAllPairData();
    
    if (allData.length > 0) {
      const message = JSON.stringify({
        type: 'all',
        data: allData
      });

      this.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  }

  public cleanup(): void {
    if (this.binanceWs) {
      this.binanceWs.close();
    }
    this.clients.forEach((client) => client.close());
    this.wss.close();
  }
}

const SOLANA_CLUSTER = "https://api.mainnet-beta.solana.com";
const SOLANA_WS_CLUSTER = "wss://api.mainnet-beta.solana.com";

async function main() {
  const server = new PriceMonitorServer();

  process.on("SIGINT", () => {
    console.log("Cleaning up...");
    server.cleanup();
    process.exit();
  });

  try {
    await server.initialize();
    console.log("Price monitor server initialized and running...");
  } catch (error) {
    console.error("Error starting price monitor server:", error);
    server.cleanup();
    process.exit(1);
  }
}

main();