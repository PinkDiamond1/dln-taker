import {
  ChainId,
  CoingeckoPriceFeed,
  Evm,
  JupiterWrapper,
  OneInchConnector,
  PMMClient,
  PriceTokenService,
  setSlippageOverloader,
  Solana,
  SwapConnector,
  SwapConnectorImpl,
  TokensBucket,
} from "@debridge-finance/dln-client";
import { helpers } from "@debridge-finance/solana-utils";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Logger } from "pino";

import { ChainDefinition, ExecutorLaunchConfig, SupportedChain } from "../config";
import { PRODUCTION } from "../environments";
import * as filters from "../filters";
import { OrderFilter } from "../filters";
import { GetNextOrder, IncomingOrder, OrderInfoStatus } from "../interfaces";
import { WsNextOrder } from "../orderFeeds/ws.order.feed";
import * as processors from "../processors";
import { EvmProviderAdapter } from "../providers/evm.provider.adapter";
import { ProviderAdapter } from "../providers/provider.adapter";
import { SolanaProviderAdapter } from "../providers/solana.provider.adapter";
import { HooksEngine } from "../hooks/HooksEngine";


const BLOCK_CONFIRMATIONS_HARD_CAPS: { [key in SupportedChain]: number } = {
  [SupportedChain.Avalanche]: 15,
  [SupportedChain.Arbitrum]: 15,
  [SupportedChain.BSC]: 15,
  [SupportedChain.Ethereum]: 12,
  [SupportedChain.Polygon]: 256,
  [SupportedChain.Solana]: 32,
  [SupportedChain.Fantom]: 15,
}

export type ExecutorInitializingChain = {
  chain: ChainId;
  chainRpc: string;
  unlockProvider: ProviderAdapter;
  fulfillProvider: ProviderAdapter;
  client: Solana.PmmClient | Evm.PmmEvmClient;
};

type UsdWorthBlockConfirmationConstraints = Array<{
  usdWorthFrom: number,
  usdWorthTo: number,
  minBlockConfirmations: number,
}>;

export type ExecutorSupportedChain = {
  chain: ChainId;
  chainRpc: string;
  srcFilters: OrderFilter[];
  dstFilters: OrderFilter[];
  usdAmountConfirmations: UsdWorthBlockConfirmationConstraints;
  orderProcessor: processors.IOrderProcessor;
  unlockProvider: ProviderAdapter;
  fulfillProvider: ProviderAdapter;
  beneficiary: string;
  client: Solana.PmmClient | Evm.PmmEvmClient;
};

export interface IExecutor {
  readonly tokenPriceService: PriceTokenService;
  readonly swapConnector: SwapConnector;
  readonly orderFeed: GetNextOrder;
  readonly chains: { [key in ChainId]?: ExecutorSupportedChain };
  readonly buckets: TokensBucket[];
  readonly client: PMMClient;
}

export class Executor implements IExecutor {
  tokenPriceService: PriceTokenService;
  swapConnector: SwapConnector;
  orderFeed: GetNextOrder;
  chains: { [key in ChainId]?: ExecutorSupportedChain } = {};
  buckets: TokensBucket[] = [];
  client: PMMClient;

  private isInitialized = false;
  private readonly url1Inch = "https://nodes.debridge.finance";
  constructor(private readonly logger: Logger) { }

  async init(config: ExecutorLaunchConfig) {
    if (this.isInitialized) return;

    this.tokenPriceService =
      config.tokenPriceService || new CoingeckoPriceFeed();

    if (config.swapConnector) {
      throw new Error("Custom swapConnector not implemented");
    }
    const oneInchConnector = new OneInchConnector(this.url1Inch);
    const jupiterConnector = new JupiterWrapper();
    this.swapConnector = new SwapConnectorImpl(
      oneInchConnector,
      jupiterConnector
    );

    this.buckets = config.buckets;
    const hooksEngine = new HooksEngine(config.hookHandlers || {}, this.logger);

    const clients: { [key in number]: any } = {};
    for (const chain of config.chains) {
      this.logger.info(`initializing ${ChainId[chain.chain]}...`);

      if (!SupportedChain[chain.chain]) {
        throw new Error(`${ChainId[chain.chain]} is not supported, remove it from the config`)
      }

      let client, unlockProvider, fulfillProvider;
      if (chain.chain === ChainId.Solana) {
        const solanaConnection = new Connection(chain.chainRpc);
        const solanaPmmSrc = new PublicKey(
          chain.environment?.pmmSrc ||
          PRODUCTION.chains[ChainId.Solana]!.pmmSrc!
        );
        const solanaPmmDst = new PublicKey(
          chain.environment?.pmmDst ||
          PRODUCTION.chains[ChainId.Solana]!.pmmDst!
        );
        const solanaDebridge = new PublicKey(
          chain.environment?.deBridgeContract ||
          PRODUCTION.chains![ChainId.Solana]!.deBridgeContract!
        );
        const solanaDebridgeSetting = new PublicKey(
          chain.environment?.solana?.debridgeSetting ||
          PRODUCTION.chains![ChainId.Solana]!.solana!.debridgeSetting!
        );

        const decodeKey = (key: string) =>
          Keypair.fromSecretKey(
            chain.takerPrivateKey.startsWith("0x")
              ? helpers.hexToBuffer(key)
              : bs58.decode(key)
          );
        fulfillProvider = new SolanaProviderAdapter(
          solanaConnection,
          decodeKey(chain.takerPrivateKey)
        );
        unlockProvider = new SolanaProviderAdapter(
          solanaConnection,
          decodeKey(chain.unlockAuthorityPrivateKey)
        );

        client = new Solana.PmmClient(
          solanaConnection,
          solanaPmmSrc,
          solanaPmmDst,
          solanaDebridge,
          solanaDebridgeSetting
        );
        await client.destination.debridge.init();

        // TODO: wait until solana enables getProgramAddress with filters for ALT and init ALT if needed
        const altInitTx = await client.initForFulfillPreswap(
          new PublicKey(chain.beneficiary),
          config.chains.map(chainConfig => chainConfig.chain),
          jupiterConnector
        );
        if (altInitTx) {
          this.logger.info(`Initializing Solana Address Lookup Table (ALT)`)
          await fulfillProvider.sendTransaction(altInitTx, { logger: this.logger })
        } else {
          this.logger.info(`Solana Address Lookup Table (ALT) already exists`)
        }
      } else {
        unlockProvider = new EvmProviderAdapter(chain.chain, chain.chainRpc, chain.unlockAuthorityPrivateKey);
        fulfillProvider = new EvmProviderAdapter(chain.chain, chain.chainRpc, chain.takerPrivateKey, chain.environment?.evm?.evmRebroadcastAdapterOpts);

        client = new Evm.PmmEvmClient({
          enableContractsCache: true,
          addresses: {
            [chain.chain]: {
              pmmSourceAddress:
                chain.environment?.pmmSrc ||
                PRODUCTION.defaultEvmAddresses?.pmmSrc ||
                PRODUCTION.chains[chain.chain]?.pmmSrc,
              pmmDestinationAddress:
                chain.environment?.pmmDst ||
                PRODUCTION.defaultEvmAddresses?.pmmDst ||
                PRODUCTION.chains[chain.chain]?.pmmDst,
              deBridgeGateAddress:
                chain.environment?.deBridgeContract ||
                PRODUCTION.defaultEvmAddresses?.deBridgeContract ||
                PRODUCTION.chains[chain.chain]?.deBridgeContract,
              crossChainForwarderAddress:
                chain.environment?.evm?.forwarderContract ||
                PRODUCTION.defaultEvmAddresses?.evm?.forwarderContract ||
                PRODUCTION.chains[chain.chain]?.evm?.forwarderContract,
            },
          },
        });
      }

      const processorInitializer =
        chain.orderProcessor ||
        config.orderProcessor ||
        processors.universalProcessor();
      const initializingChain = {
        chain: chain.chain,
        chainRpc: chain.chainRpc,
        unlockProvider,
        fulfillProvider: fulfillProvider,
        client,
      };
      const orderProcessor = await processorInitializer(chain.chain, {
        takeChain: initializingChain,
        buckets: config.buckets,
        logger: this.logger,
        hooksEngine,
      });

      const dstFiltersInitializers = chain.dstFilters || [];
      if (chain.disabled) {
        dstFiltersInitializers.push(filters.disableFulfill());
      }

      // append global filters to the list of dstFilters
      const dstFilters = await Promise.all(
        [...dstFiltersInitializers, ...(config.filters || [])].map((filter) =>
          filter(chain.chain, {
            chain: initializingChain,
            logger: this.logger,
          })
        )
      );

      const srcFilters = await Promise.all(
        (chain.srcFilters || []).map((initializer) =>
          initializer(chain.chain, {
            chain: initializingChain,
            logger: this.logger,
          })
        )
      );

      this.chains[chain.chain] = {
        chain: chain.chain,
        chainRpc: chain.chainRpc,
        srcFilters,
        dstFilters,
        orderProcessor,
        unlockProvider,
        fulfillProvider: fulfillProvider,
        client,
        usdAmountConfirmations: this.getConfirmationRanges(chain.chain as unknown as SupportedChain, chain),
        beneficiary: chain.beneficiary,
      };

      clients[chain.chain] = client;
    }

    this.client = new PMMClient(clients);

    let orderFeed = config.orderFeed as GetNextOrder;
    if (typeof orderFeed === "string" || !orderFeed) {
      orderFeed = new WsNextOrder(orderFeed);
    }
    orderFeed.setEnabledChains(
      Object.values(this.chains).map((chain) => chain.chain)
    );
    orderFeed.setLogger(this.logger);
    this.orderFeed = orderFeed;

    const unlockAuthorities = Object.values(this.chains).map((chain) => {
      return {
        chainId: chain.chain,
        address: chain.unlockProvider.address as string,
      };
    });
    const minConfirmationThresholds = Object.values(this.chains).map(chain => ({
      chainId: chain.chain,
      points: chain.usdAmountConfirmations.map(t => t.minBlockConfirmations)
    }))
    orderFeed.init(this.execute.bind(this), unlockAuthorities, minConfirmationThresholds, hooksEngine);

    // Override internal slippage calculation: do not reserve slippage buffer for pre-fulfill swap
    setSlippageOverloader(() => 0);

    this.isInitialized = true;
  }

  private getConfirmationRanges(chain: SupportedChain, definition: ChainDefinition): UsdWorthBlockConfirmationConstraints {
    const ranges: UsdWorthBlockConfirmationConstraints = [];
    const requiredConfirmationsThresholds = definition.constraints?.requiredConfirmationsThresholds || [];
    requiredConfirmationsThresholds
      .sort((a, b) => a.thresholdAmountInUSD < b.thresholdAmountInUSD ? -1 : 1) // sort by usdWorth ASC
      .forEach((threshold, index, thresholdsSortedByUsdWorth) => {
        const prev = index === 0 ? {minBlockConfirmations: 0, thresholdAmountInUSD: 0} : thresholdsSortedByUsdWorth[index - 1];

        if (threshold.minBlockConfirmations <= prev.minBlockConfirmations) {
          throw new Error(`Unable to set required confirmation threshold for $${threshold.thresholdAmountInUSD} on ${SupportedChain[chain]}: minBlockConfirmations (${threshold.minBlockConfirmations}) must be greater than ${prev.minBlockConfirmations}`)
        }
        if (BLOCK_CONFIRMATIONS_HARD_CAPS[chain] <= threshold.minBlockConfirmations) {
          throw new Error(`Unable to set required confirmation threshold for $${threshold.thresholdAmountInUSD} on ${SupportedChain[chain]}: minBlockConfirmations (${threshold.minBlockConfirmations}) must be less than max block confirmations (${BLOCK_CONFIRMATIONS_HARD_CAPS[chain]})`)
        }

        ranges.push({
          usdWorthFrom: prev.thresholdAmountInUSD,
          usdWorthTo: threshold.thresholdAmountInUSD,
          minBlockConfirmations: threshold.minBlockConfirmations
        })
      });

    return ranges;
  }

  async execute(nextOrderInfo: IncomingOrder<any>) {
    const orderId = nextOrderInfo.orderId;
    const logger = this.logger.child({ orderId });
    logger.info(`new order received, type: ${OrderInfoStatus[nextOrderInfo.status]}`)
    logger.debug(nextOrderInfo);
    try {
      await this.executeOrder(nextOrderInfo, logger);
    } catch (e) {
      logger.error(`received error while order execution: ${e}`);
      logger.error(e);
    }
  }

  private async executeOrder(
    nextOrderInfo: IncomingOrder<any>,
    logger: Logger
  ): Promise<boolean> {
    const { order, orderId } = nextOrderInfo;
    if (!order || !orderId) throw new Error("Order is undefined");

    const takeChain = this.chains[order.take.chainId];
    if (!takeChain) {
      logger.info(`${ChainId[order.take.chainId]} not configured, dropping`);
      return false;
    }

    const giveChain = this.chains[order.give.chainId];
    if (!giveChain) {
      logger.info(`${ChainId[order.give.chainId]} not configured, dropping`);
      return false;
    }

    // to accept an order, all filters must approve the order.
    // executor invokes three groups of filters:
    // 1) defined globally (config.filters)
    // 2) defined as dstFilters under the takeChain config
    // 3) defined as srcFilters under the giveChain config

    // global filters
    const listOrderFilters = [];

    // dstFilters@takeChain
    if (takeChain.dstFilters && takeChain.dstFilters.length > 0) {
      listOrderFilters.push(...takeChain.dstFilters);
    }

    // srcFilters@giveChain
    if (giveChain.srcFilters && giveChain.srcFilters.length > 0) {
      listOrderFilters.push(...giveChain.srcFilters);
    }

    //
    // run filters for create or archival orders
    //
    if (
      [OrderInfoStatus.Created, OrderInfoStatus.ArchivalCreated].includes(
        nextOrderInfo.status
      )
    ) {
      logger.debug("running filters against the order");
      const orderFilters = await Promise.all(
        listOrderFilters.map((filter) =>
          filter(order, {
            logger,
            config: this,
            giveChain,
            takeChain,
          })
        )
      );

      if (!orderFilters.every((it) => it)) {
        logger.info("order has been filtered off, dropping");
        return false;
      }
    } else {
      logger.debug("accepting order as is");
    }

    //
    // run processor
    //
    logger.debug(`passing the order to the processor`);
    takeChain.orderProcessor.process({
      orderInfo: nextOrderInfo,
      context: {
        logger,
        config: this,
        giveChain,
      },
      attempts: 0
    });

    return true;
  }
}
