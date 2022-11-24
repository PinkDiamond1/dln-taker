import { ChainId, OrderData, OrderState } from "@debridge-finance/dln-client";
import { helpers } from "@debridge-finance/solana-utils";
import Web3 from "web3";

import { ExecutorConfig } from "../config";
import { evmNativeTokenAddress, solanaNativeTokenAddress } from "../constant";
import {
  MarketMakerExecutorError,
  MarketMakerExecutorErrorType,
} from "../error";

import {OrderProcessor, OrderProcessorContext, OrderProcessorInitContext} from "./order.processor";
import { SolanaProviderAdapter } from "../providers/solana.provider.adapter";
import { EvmAdapterProvider } from "../providers/evm.provider.adapter";
import { convertAddressToBuffer } from "../utils/convert.address.to.buffer";
import { buffersAreEqual } from "../utils/buffers.are.equal";

export class StrictProcessor extends OrderProcessor {
  private approvedTokensInBuffer: Uint8Array[];
  constructor(private readonly approvedTokens: string[]) {
    super();
  }

  async init(chainId: ChainId, context: OrderProcessorInitContext): Promise<void> {
    this.chainId = chainId;
    this.context = context;
    const chainConfig = context.executorConfig.chains.find(chain => chain.chain === chainId)!;
    this.approvedTokensInBuffer = this.approvedTokens.map(token => convertAddressToBuffer(chainConfig.chain, token));
    if (chainId !== ChainId.Solana) {
      await Promise.all(this.approvedTokens.map(token => this.approveToken(token, chainConfig!.environment!.pmmDst!)));
    }
    return Promise.resolve();
  }

  async process(orderId: string, order: OrderData, executorConfig: ExecutorConfig, context: OrderProcessorContext): Promise<void> {
    const takeProviderUnlock = context.providersForUnlock.get(order.take.chainId);
    const takeProviderFulfill = context.providersForFulfill.get(order.take.chainId);
    const chainConfig = executorConfig.chains.find(chain => chain.chain === order.take.chainId)!;
    const logger = context.logger.child({ processor: "strictProcessor" });

    const takeTokenAddressHex = helpers.bufferToHex(Buffer.from(order.take.tokenAddress));
    if (!this.approvedTokensInBuffer.some(address => buffersAreEqual(order.take.tokenAddress, address))) {
      logger.info(`takeToken ${takeTokenAddressHex} is not allowed`);
      return;
    }
    let giveWeb3: Web3;
    if (order.give.chainId !== ChainId.Solana) {
      giveWeb3 = new Web3(
        executorConfig.chains.find(
          (chain) => chain.chain === order.give.chainId
        )!.chainRpc
      );
    }

    let takeWeb3: Web3;
    if (order.take.chainId !== ChainId.Solana) {
      takeWeb3 = new Web3(chainConfig!.chainRpc);
    }

    const [giveNativePrice, takeNativePrice] = await Promise.all([
      executorConfig.tokenPriceService!.getPrice(
        order.give.chainId,
        order.give.chainId !== ChainId.Solana
          ? evmNativeTokenAddress
          : solanaNativeTokenAddress
      ),
      executorConfig.tokenPriceService!.getPrice(
        order.take.chainId,
        order.take.chainId !== ChainId.Solana
          ? evmNativeTokenAddress
          : solanaNativeTokenAddress
      ),
    ]);
    const fees = await context.client.getTakerFlowCost(
      order,
      giveNativePrice,
      takeNativePrice,
      { giveWeb3: giveWeb3!, takeWeb3: takeWeb3! }
    );
    logger.debug(`fees=${JSON.stringify(fees)}`);

    const executionFeeAmount = await context.client.getAmountToSend(
      order.take.chainId,
      order.give.chainId,
      fees.executionFees.total,
      takeWeb3!
    );

    let fulfillTx;
    if (order.take.chainId === ChainId.Solana) {
      const wallet = (takeProviderFulfill as SolanaProviderAdapter).wallet.publicKey;
      fulfillTx = await context.client.fulfillOrder<ChainId.Solana>(
        order,
        orderId,
        {
          taker: wallet,
        }
      );
      logger.debug(
        `fulfillTx is created in solana ${JSON.stringify(fulfillTx)}`
      );
    } else {
      fulfillTx = await context.client.fulfillOrder<ChainId.Ethereum>(
        order,
        orderId,
        {
          web3: (takeProviderFulfill as EvmAdapterProvider).connection,
          fulfillAmount: Number(order.take.amount),
          permit: "0x",
          unlockAuthority: takeProviderUnlock!.address,
        }
      );
      logger.debug(
        `fulfillTx is created in ${order.take.chainId} ${JSON.stringify(
          fulfillTx
        )}`
      );
    }

    if (context.orderFulfilledMap.has(orderId)) {
      context.orderFulfilledMap.delete(orderId);
      throw new MarketMakerExecutorError(
        MarketMakerExecutorErrorType.OrderIsFulfilled
      );
    }

    try {
      const txFulfill = await takeProviderFulfill!.sendTransaction(fulfillTx, { logger });
      logger.info(`fulfill transaction ${txFulfill} is completed`);
    }
    catch (e) {
      console.error(e)
      logger.info(`fulfill transaction failed: ${e}`);
      return;
    }

    if (order.take.chainId === ChainId.Solana) {
      let state = await context.client.getTakeOrderStatus(
        orderId,
        order.take.chainId,
        { web3: takeWeb3! }
      );
      const limit = 10;
      let iteration = 0;
      while (state === null || state.status !== OrderState.Fulfilled) {
        if (iteration === limit) throw new Error("Failed to wait for order fulfillment, retries limit reached")
        state = await context.client.getTakeOrderStatus(
          orderId,
          order.take.chainId
        );
        logger.debug(`state=${JSON.stringify(state)}`);
        await helpers.sleep(2000);
        iteration += 1;
      }
    }

    const beneficiary = executorConfig.chains.find(
      (chain) => chain.chain === order.give.chainId
    )!.beneficiary;

    let unlockTx;
    if (order.take.chainId === ChainId.Solana) {
      const wallet = (takeProviderUnlock as SolanaProviderAdapter).wallet.publicKey;
      unlockTx = await context.client.sendUnlockOrder<ChainId.Solana>(
        order,
        beneficiary,
        executionFeeAmount,
        {
          unlocker: wallet,
        }
      );
      logger.debug(`unlockTx is created in solana ${JSON.stringify(unlockTx)}`);
    } else {
      const rewards =
        order.give.chainId === ChainId.Solana
          ? {
            reward1: fees.executionFees.rewards[0].toString(),
            reward2: fees.executionFees.rewards[1].toString(),
          }
          : {
            reward1: "0",
            reward2: "0",
          };
      unlockTx = await context.client.sendUnlockOrder<ChainId.Polygon>(
        order,
        beneficiary,
        executionFeeAmount,
        {
          web3: (takeProviderUnlock as EvmAdapterProvider).connection,
          ...rewards,
        }
      );
      logger.debug(
        `unlockTx is created in ${order.take.chainId} ${JSON.stringify(
          unlockTx
        )}`
      );
    }
    const transactionUnlock = await takeProviderUnlock!.sendTransaction(unlockTx, { logger });
    logger.info(`unlock transaction ${transactionUnlock} is completed`);

    return Promise.resolve(undefined);
  }
}

export const strictProcessor = (approvedTokens: string[]): OrderProcessor => {
  return new StrictProcessor(approvedTokens);
};
