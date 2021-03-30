import { splitSignature } from "@ethersproject/bytes";
import { FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import { BigNumber, Contract, ethers, providers, Signer, Wallet } from "ethers";
import { formatUnits, isAddress } from "ethers/lib/utils";
import { Base } from "./Base";

import { ERC20 } from "../typechain/ERC20";
import { abi as ERC20Abi } from "../abi/ERC20";

export class TransferERC20 extends Base {
  private _provider: providers.JsonRpcProvider;
  private _erc20Sender: Wallet;
  private _briber: Signer;
  private _recipient: string;
  private _erc20: ERC20;

  constructor(
    provider: providers.JsonRpcProvider,
    erc20Sender: Wallet,
    briber: Signer,
    recipient: string,
    erc20Address: string
  ) {
    super();
    if (!isAddress(recipient)) throw new Error("Bad recipient address");
    if (!isAddress(erc20Address)) throw new Error("Bad erc20 address");

    this._erc20Sender = erc20Sender;

    this._briber = briber;
    this._provider = provider;
    this._recipient = recipient;

    this._erc20 = new Contract(erc20Address, ERC20Abi, provider) as ERC20;
  }

  async getDescription(): Promise<string> {
    const erc20Sender = await this.getERC20SenderAddress();

    return (
      "Transfer ERC20 balance " +
      (await this.getTokenBalance(erc20Sender)).toString() +
      " @ " +
      this._erc20.address +
      " from " +
      erc20Sender +
      " to " +
      this._recipient
    );
  }

  async getZeroGasPriceTx(): Promise<Array<FlashbotsBundleTransaction>> {
    const erc20Sender = await this.getERC20SenderAddress();

    const tokenBalance = await this.getTokenBalance(
      await this.getERC20SenderAddress()
    );

    if (tokenBalance.eq(0)) {
      throw new Error(
        `No Token Balance: ${erc20Sender} does not have any balance of ${this._erc20.address}`
      );
    }
    return [
      {
        transaction: {
          ...(await this._erc20.populateTransaction.transfer(
            this._recipient,
            tokenBalance
          )),
          gasPrice: BigNumber.from(0),
          gasLimit: BigNumber.from(120000),
        },
        signer: this._erc20Sender,
      },
    ];
  }

  private async getTokenBalance(tokenHolder: string): Promise<BigNumber> {
    return (await this._erc20.functions.balanceOf(tokenHolder))[0];
  }

  private async getERC20SenderAddress(): Promise<string> {
    return this._erc20Sender.getAddress();
  }

  private async getBriberAddress(): Promise<string> {
    return this._briber.getAddress();
  }

  async getDonorTxWithWETH(
    minerReward: BigNumber
  ): Promise<FlashbotsBundleTransaction> {
    const erc20SenderAddress = await this.getERC20SenderAddress();
    const briberAddress = await this.getBriberAddress();

    const checkTargets = [this._erc20.address];
    const checkPayloads = [
      this._erc20.interface.encodeFunctionData("balanceOf", [this._recipient]),
    ];

    // recipient might ALREADY have a balance of these tokens. checkAndSend only checks the final state, so make sure the final state is precalculated
    const expectedBalance = (
      await this.getTokenBalance(erc20SenderAddress)
    ).add(await this.getTokenBalance(this._recipient));
    const checkMatches = [
      this._erc20.interface.encodeFunctionResult("balanceOf", [
        expectedBalance,
      ]),
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
    const deadline = parseInt((new Date().getTime() / 1000).toString()) + (1 * 60 * 60); // Gives 1 hour

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
    const checkTargets = [this._erc20.address];
    const checkPayloads = [
      this._erc20.interface.encodeFunctionData("balanceOf", [this._recipient]),
    ];
    // recipient might ALREADY have a balance of these tokens. checkAndSend only checks the final state, so make sure the final state is precalculated
    const expectedBalance = (
      await this.getTokenBalance(await this.getERC20SenderAddress())
    ).add(await this.getTokenBalance(this._recipient));
    const checkMatches = [
      this._erc20.interface.encodeFunctionResult("balanceOf", [
        expectedBalance,
      ]),
    ];
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
