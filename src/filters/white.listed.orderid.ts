import {
  buffersAreEqual,
  ChainId,
  Order,
  OrderData,
  tokenStringToBuffer,
} from "@debridge-finance/dln-client";
import { helpers } from "@debridge-finance/solana-utils";

import {
  FilterContext,
  OrderFilter,
  OrderFilterInitContext,
  OrderFilterInitializer,
} from "./order.filter";

export function whitelistedOrderId(
  orderIds: string[]
): OrderFilterInitializer {
  return async (
    chainId: ChainId,
    context: OrderFilterInitContext
  ): Promise<OrderFilter> => {
    return async (
      order: OrderData,
      context: FilterContext
    ): Promise<boolean> => {
      const logger = context.logger.child({ filter: "whitelistedOrderId" });
      const result = orderIds.some((orderId) =>
        orderId === Order.calculateId(order)
      );

      logger.info(`approve status: ${result}, orderId is whitelisted`);
      return Promise.resolve(result);
    };
  };
}
