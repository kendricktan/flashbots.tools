import { BigNumber, Contract } from "ethers";
import { FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";

import { MevBriber } from "../typechain/MevBriber";
import { Iweth } from "../typechain/Iweth";

import { abi as WETHAbi } from "../abi/WETH";
import { abi as MEVBriberAbi } from "../abi/MEVBriber";

export const MEV_BRIBER_ADDRESS = "0xf26F7dAa038651F6eFcA888E91ecbeC8e231035e";
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export abstract class Base {

  public static mevBriberContract = new Contract(
    MEV_BRIBER_ADDRESS,
    MEVBriberAbi
  ) as MevBriber;

  public static wethContract = new Contract(WETH_ADDRESS, WETHAbi) as Iweth;

  abstract getZeroGasPriceTx(): Promise<Array<FlashbotsBundleTransaction>>;

  abstract getDonorTx(minerReward: BigNumber): Promise<FlashbotsBundleTransaction>;

  abstract getDescription(): Promise<string>;
}
