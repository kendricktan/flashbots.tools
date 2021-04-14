import { splitSignature } from "@ethersproject/bytes";
import { FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import { BigNumber, Contract, ethers, providers, Signer, Wallet } from "ethers";
import { formatUnits, isAddress } from "ethers/lib/utils";
import { Base } from "./Base";
import { namehash } from "@ensdomains/ensjs";

import { ENS } from "../typechain/ENS";
import { abi as ENSAbi } from "../abi/ENS";

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

export class TransferENS extends Base {
  private _provider: providers.JsonRpcProvider;
  private _ensSender: Wallet;
  private _briber: Wallet;
  private _recipient: string;
  private _ens: ENS;
  private _ensDomain: string;
  private _ensDomainHashed: string;

  constructor(
    provider: providers.JsonRpcProvider,
    ensSender: Wallet,
    briber: Wallet,
    ensDomain: string,
    recipient: string
  ) {
    super();
    if (!isAddress(recipient)) throw new Error("Bad recipient address");

    this._ensSender = ensSender;

    this._briber = briber;
    this._provider = provider;
    this._recipient = recipient;
    this._ensDomain = ensDomain;
    this._ensDomainHashed = namehash(ensDomain);

    this._ens = new Contract(ENS_REGISTRY, ENSAbi, provider) as ENS;
  }

  async getDescription(): Promise<string> {
    const ensSender = await this.getENSSenderAddress();

    return (
      `Transfer ENS domain ${this._ensDomain}` +
      " from " +
      ensSender +
      " to " +
      this._recipient
    );
  }

  async getZeroGasPriceTx(): Promise<Array<FlashbotsBundleTransaction>> {
    const ensSender = await this.getENSSenderAddress();

    const owner = await this._ens.owner(this._ensDomainHashed);

    if (owner.toLowerCase() !== ensSender.toLowerCase()) {
      throw new Error(`${ensSender} is not the owner of ${this._ensDomain}`);
    }

    return [
      {
        transaction: {
          ...(await this._ens.populateTransaction.setOwner(
            this._ensDomainHashed,
            this._recipient
          )),
          gasPrice: BigNumber.from(0),
          gasLimit: BigNumber.from(120000),
        },
        signer: this._ensSender,
      },
    ];
  }

  private async getENSSenderAddress(): Promise<string> {
    return this._ensSender.getAddress();
  }

  private async getBriberAddress(): Promise<string> {
    return this._briber.getAddress();
  }

  async getDonorTxWithWETH(
    minerReward: BigNumber
  ): Promise<FlashbotsBundleTransaction> {
    const briberAddress = await this.getBriberAddress();

    const checkTargets = [this._ens.address];
    const checkPayloads = [
      this._ens.interface.encodeFunctionData("owner", [this._ensDomainHashed]),
    ];

    const checkMatches = [
      this._ens.interface.encodeFunctionResult("owner", [this._recipient]),
    ];

    // Check WETH Balance
    const balance = await Base.wethContract
      .connect(this._briber)
      .balanceOf(briberAddress);
    if (balance.lt(minerReward)) {
      throw new Error(
        `Not enough WETH to bribe miner. Have ${formatUnits(
          balance
        )} WETH in account, need ${formatUnits(
          minerReward
        )} WETH to bribe miner`
      );
    }

    // Check WETH allowance
    const allowance = await Base.wethContract
      .connect(this._briber)
      .allowance(briberAddress, Base.mevBriberContract.address);

    // Not enough allowance, we need to approve it
    if (allowance.lt(minerReward)) {
      console.log("Approving WETH spending for miner");
      console.log("Allowance", allowance.toString());
      console.log("minerReward", minerReward.toString());
      const tx = await Base.wethContract
        .connect(this._briber)
        .approve(Base.mevBriberContract.address, minerReward);
      console.log("Waiting for tx to be mined....");
      await tx.wait();
    }

    // Sign typed data
    const deadline =
      parseInt((new Date().getTime() / 1000).toString()) + 1 * 60 * 60; // Gives 1 hour

    const EIP712Domain = [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ];
    const domain = {
      name: "MEVBriber",
      version: "1",
      chainId: 1,
      verifyingContract: Base.mevBriberContract.address,
    };
    const Permit = [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ];
    const message = {
      owner: briberAddress,
      spender: Base.mevBriberContract.address,
      value: minerReward.toString(),
      nonce: (
        await Base.mevBriberContract
          .connect(this._provider)
          .nonces(briberAddress)
      ).toString(),
      deadline, // 10 minutes
    };
    const data = JSON.stringify({
      types: {
        EIP712Domain,
        Permit,
      },
      domain,
      primaryType: "Permit",
      message,
    });

    const signature = await this._provider
      .send("eth_signTypedData_v4", [briberAddress, data])
      .then((x) => {
        return splitSignature(x);
      });

    const sender = ethers.Wallet.createRandom().connect(this._provider);

    return {
      transaction: {
        ...(await Base.mevBriberContract.populateTransaction.check32BytesAndSendMultiWETH(
          message.owner,
          message.spender,
          message.value,
          message.deadline,
          signature.v,
          signature.r,
          signature.s,
          checkTargets,
          checkPayloads,
          checkMatches
        )),
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(400000),
      },
      signer: sender,
    };
  }
  async getDonorTx(
    minerReward: BigNumber
  ): Promise<FlashbotsBundleTransaction> {


    const checkTargets = [this._ens.address];
    const checkPayloads = [
      this._ens.interface.encodeFunctionData("owner", [this._ensDomainHashed]),
    ];

    const checkMatches = [
      this._ens.interface.encodeFunctionResult("owner", [this._recipient]),
    ];
    // const checkMatches: string[] = [];
    // console.log("checkMatches", checkMatches);
    return {
      transaction: {
        ...(await Base.mevBriberContract.populateTransaction.check32BytesAndSendMulti(
          checkTargets,
          checkPayloads,
          checkMatches
        )),
        value: minerReward,
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(600000),
      },
      signer: this._briber,
    };
  }
}
