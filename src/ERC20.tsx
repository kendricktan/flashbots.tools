import {
  Link,
  Button,
  Spacer,
  Text,
  Card,
  Input,
  Row,
  Col,
  Tooltip,
  Loading,
} from "@geist-ui/react";

import QuestionCircle from "@geist-ui/react-icons/questionCircle";

import { ethers } from "ethers";
import { useState } from "react";

import { Connection } from "./containers/Connection";

import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
  FlashbotsBundleTransaction,
} from "@flashbots/ethers-provider-bundle";

import {
  checkSimulation,
  gasPriceToGwei,
  getTransactionsLog,
} from "./engine/Utils";

import { Base } from "./engine/Base";
import { TransferERC20 } from "./engine/TransferERC20";
import { parseUnits } from "ethers/lib/utils";

export enum TransferERC20Progress {
  NotStarted,
  GetWETH,
  ApproveContract,
  SignTransaction,
  BroadcastingTransaction,
  Success,
  Failed,
}

export function ERC20({
  blocksInTheFuture,
  relayerURL,
}: {
  blocksInTheFuture: string;
  relayerURL: string;
}) {
  const { provider, signer } = Connection.useContainer();

  const [compromisedPrivateKey, setCompromisedPrivateKey] = useState("");
  const [erc20Address, setERC20Address] = useState("");
  const [erc20Recipient, setERC20Recipient] = useState("");
  const [ethBribeAmount, setEthBribeAmount] = useState("0.05");
  const [rescuingState, setRescuingState] = useState<TransferERC20Progress>(
    TransferERC20Progress.NotStarted
  );

  // eslint-disable-next-line
  const [_, setThreadId] = useState<NodeJS.Timeout | null>(null);

  const [invalidPrivateKey, setInvalidPrivateKey] = useState(false);
  const [invalidERC20Address, setInvalidERC20Address] = useState(false);
  const [invalidERC20Recipient, setInvalidERC20Recipient] = useState(false);

  const [successTxHash, setSuccessTxHash] = useState("");

  const [failReason, setFailReason] = useState("");
  const [failReasonVerbose, setFailReasonVerbose] = useState("");

  const [lastBlockTried, setLastBlockTried] = useState(0);

  const [broadcastAttempts, setBroadcastAttempts] = useState(0);

  const validateInputs = () => {
    let valid = true;

    if (provider && signer) {
      try {
        new ethers.Wallet(compromisedPrivateKey, provider);
        setInvalidPrivateKey(false);
      } catch (e) {
        valid = false;
        setInvalidPrivateKey(true);
      }
    }

    if (!ethers.utils.isAddress(erc20Address)) {
      setInvalidERC20Address(true);
      valid = false;
    } else {
      setInvalidERC20Address(false);
    }

    if (!ethers.utils.isAddress(erc20Recipient)) {
      setInvalidERC20Recipient(true);
      valid = false;
    } else {
      setInvalidERC20Recipient(false);
    }

    return valid;
  };

  const rescueERC20 = async () => {
    if (provider && signer) {
      // Wallets
      const walletAuth = ethers.Wallet.createRandom(provider);
      const walletZeroGas = new ethers.Wallet(compromisedPrivateKey, provider);
      const signerAddress = await signer.getAddress();
      const bribeAmount = parseUnits(ethBribeAmount);

      // Make sure sender has enough ETH and approved enough allowance to the contract
      // Check WETH Balance
      const wethContract = Base.wethContract.connect(signer);
      const balance = await wethContract.balanceOf(signerAddress);

      if (balance.lt(bribeAmount)) {
        setRescuingState(TransferERC20Progress.GetWETH);
        const tx = await wethContract.deposit({ value: bribeAmount });
        await tx.wait();
      }

      // Check WETH allowance
      const allowance = await wethContract.allowance(
        signerAddress,
        Base.mevBriberContract.address
      );

      // Not enough allowance, we need to approve it
      if (allowance.lt(bribeAmount)) {
        setRescuingState(TransferERC20Progress.ApproveContract);
        const tx = await wethContract.approve(
          Base.mevBriberContract.address,
          bribeAmount
        );
        await tx.wait();
      }

      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        walletAuth,
        relayerURL
      );
      const engine = new TransferERC20(
        provider,
        walletZeroGas,
        signer,
        erc20Recipient,
        erc20Address
      );

      let zeroGasTxs: FlashbotsBundleTransaction[];
      try {
        zeroGasTxs = await engine.getZeroGasPriceTx();
      } catch (e) {
        console.log(`Error: ${e.toString()}`);
        setRescuingState(TransferERC20Progress.Failed);
        setFailReason("Failed to construct erc20 transfer tx");
        setFailReasonVerbose(e.toString());
        return;
      }

      setRescuingState(TransferERC20Progress.SignTransaction);
      const donorTx = await engine.getDonorTxWithWETH(bribeAmount);

      const bundleTransactions: Array<FlashbotsBundleTransaction> = [
        ...zeroGasTxs,
        donorTx,
      ];
      const signedBundle = await flashbotsProvider.signBundle(
        bundleTransactions
      );

      const moreLogs = await getTransactionsLog(
        bundleTransactions,
        signedBundle
      );

      console.log("moreLogs", moreLogs);

      try {
        const gasPrice = await checkSimulation(flashbotsProvider, signedBundle);
        console.log(
          `Gas price: ${gasPriceToGwei(
            gasPrice
          )} gwei\n${await engine.getDescription()}`
        );
      } catch (e) {
        console.log(`Error: ${e.toString()}`);
        setRescuingState(TransferERC20Progress.Failed);
        setFailReason(
          "Simulation failed, perhaps a non standard ERC20 transfer?"
        );
        setFailReasonVerbose(e.toString());
        return;
      }

      setBroadcastAttempts(0);
      setRescuingState(TransferERC20Progress.BroadcastingTransaction);

      const keepSubmittingTx = async () => {
        const blockNumber = await provider.getBlockNumber();

        setBroadcastAttempts((a) => a + 1);
        setLastBlockTried(blockNumber);

        let gasPrice;
        try {
          gasPrice = await checkSimulation(flashbotsProvider, signedBundle);
          console.log(
            `Gas price: ${gasPriceToGwei(
              gasPrice
            )} gwei\n${await engine.getDescription()}`
          );
        } catch (e) {
          console.log("\n" + e.toString());
          setRescuingState((prevState: TransferERC20Progress) => {
            // Only update if we've succeeded
            if (prevState === TransferERC20Progress.BroadcastingTransaction) {
              return TransferERC20Progress.Failed;
            }
            return prevState;
          });
          setFailReason("Transfer failed: Nonce too high");
          setFailReasonVerbose(
            "Account nonce has changed since message signature"
          );
          return;
        }
        const targetBlockNumber = blockNumber + parseInt(blocksInTheFuture);
        console.log(
          `Current Block Number: ${blockNumber}, Target Block Number:${targetBlockNumber}, gasPrice: ${gasPriceToGwei(
            gasPrice
          )} gwei`
        );
        const bundleResponse = await flashbotsProvider.sendBundle(
          bundleTransactions,
          targetBlockNumber
        );
        const bundleResolution = await bundleResponse.wait();
        if (bundleResolution === FlashbotsBundleResolution.BundleIncluded) {
          console.log(`Congrats, included in ${targetBlockNumber}`);
          setRescuingState((prevState: TransferERC20Progress) => {
            // Only update if we've succeeded
            if (prevState === TransferERC20Progress.BroadcastingTransaction) {
              return TransferERC20Progress.Success;
            }
            return prevState;
          });
          setSuccessTxHash(bundleResponse.bundleTransactions[0].hash);
          setThreadId((curThreadId) => {
            if (curThreadId) {
              clearInterval(curThreadId);
            }
            return null;
          });
        } else if (
          bundleResolution ===
          FlashbotsBundleResolution.BlockPassedWithoutInclusion
        ) {
          console.log(`Not included in ${targetBlockNumber}`);
        } else if (
          bundleResolution === FlashbotsBundleResolution.AccountNonceTooHigh
        ) {
          console.log("Nonce too high, bailing");
          setThreadId((curThreadId) => {
            if (curThreadId) {
              clearInterval(curThreadId);
            }
            return null;
          });
          setRescuingState((prevState: TransferERC20Progress) => {
            // Only update if we've succeeded
            if (prevState === TransferERC20Progress.BroadcastingTransaction) {
              return TransferERC20Progress.Failed;
            }
            return prevState;
          });
          setFailReason("Transfer failed: Nonce too high");
          setFailReasonVerbose(
            "Account nonce has changed since message signature"
          );
        }
      };

      keepSubmittingTx();
      setThreadId(setInterval(keepSubmittingTx, 13000));
    }
  };

  const isRescuing = !(
    rescuingState === TransferERC20Progress.NotStarted ||
    rescuingState === TransferERC20Progress.Failed ||
    rescuingState === TransferERC20Progress.Success
  );

  return (
    <Card>
      <Text h3>Gasless ERC20 Transfers</Text>
      <Text type="warning">
        Only tested on native metamask accounts. Does not work with hardware
        wallets.
      </Text>

      <Row gap={0.8}>
        <Col>
          <Spacer y={1} />
          <Input.Password
            status={invalidPrivateKey ? "error" : "default"}
            value={compromisedPrivateKey}
            onChange={(e) => setCompromisedPrivateKey(e.target.value)}
            placeholder="private key"
            width="100%"
          >
            <Text h5>
              Compromised Private Key&nbsp;
              <Tooltip
                type="secondary"
                text={
                  "Private key corresponding to the address with the ERC20 token, but no Ether"
                }
              >
                <QuestionCircle size={15} />
              </Tooltip>
              <Text type="error">
                Pasting sensitive information such as private keys online is not
                recommended. If possible, please{" "}
                <Link
                  color
                  href="http://github.com/kendricktan/flashbots.tools"
                >
                  build
                </Link>{" "}
                and run this website locally.
              </Text>
            </Text>
          </Input.Password>

          <Spacer y={1} />
          <Input
            status={invalidERC20Address ? "error" : "default"}
            value={erc20Address}
            onChange={(e) => setERC20Address(e.target.value)}
            placeholder="erc20 address"
            width="100%"
          >
            <Text h5>
              ERC20 Address&nbsp;
              <Tooltip
                type="secondary"
                text={
                  "Address of the ERC20 token that you want to transfer. It'll transfer ALL the specified ERC20 from the compromised account."
                }
              >
                <QuestionCircle size={15} />
              </Tooltip>
            </Text>
          </Input>

          <Spacer y={1} />
          <Input
            status={invalidERC20Recipient ? "error" : "default"}
            value={erc20Recipient}
            onChange={(e) => setERC20Recipient(e.target.value)}
            placeholder="erc20 address"
            width="100%"
          >
            <Text h5>
              ERC20 Recipient Address&nbsp;
              <Tooltip type="secondary" text={"Recipient of the ERC20 tokens"}>
                <QuestionCircle size={15} />
              </Tooltip>
            </Text>
          </Input>

          <Spacer y={1} />
          <Input
            value={ethBribeAmount}
            onChange={(e) => setEthBribeAmount(e.target.value)}
            placeholder="amount"
            width="100%"
          >
            <Text h5>
              Eth Bribe Amount&nbsp;
              <Tooltip
                type="secondary"
                text={"Amount of ETH used to bribe miners"}
              >
                <QuestionCircle size={15} />
              </Tooltip>
            </Text>
          </Input>
        </Col>
        <Col>
          <Row align="middle" justify="center" style={{ height: "100%" }}>
            <Col style={{ width: "100%", textAlign: "center" }}>
              {rescuingState === TransferERC20Progress.NotStarted && (
                <>
                  <Text b>Rescue your ERC20 from a compromised wallet!</Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    Note: Connected metamask account will be paying for the
                    bribes
                  </Text>
                </>
              )}
              {rescuingState === TransferERC20Progress.GetWETH && (
                <>
                  <Text b>Wrapping {ethBribeAmount} ETH into WETH</Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    1/3
                  </Text>
                  <Loading />
                </>
              )}
              {rescuingState === TransferERC20Progress.ApproveContract && (
                <>
                  <Text b>
                    Approving {ethBribeAmount} WETH to be used by bribers
                  </Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    2/3
                  </Text>
                  <Loading />
                </>
              )}
              {rescuingState === TransferERC20Progress.SignTransaction && (
                <>
                  <Text b>Sign tx to be broadcasted</Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    3/3
                  </Text>
                  <Spacer y={0.1} />
                  <Loading />
                </>
              )}
              {rescuingState ===
                TransferERC20Progress.BroadcastingTransaction && (
                <>
                  <Text b>
                    Broadcasting transaction ({broadcastAttempts} tries)
                  </Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    Attempting to mine tx on block {lastBlockTried}
                  </Text>
                  <Spacer y={1} />
                  <Text small type="secondary">
                    Do <strong>not</strong> close this window until this is
                    successful. <br />
                    If this takes too long, increase Eth bribe amount.
                  </Text>
                  <Loading />
                </>
              )}
              {rescuingState === TransferERC20Progress.Success && (
                <>
                  <Text b>
                    <Link
                      color
                      href={`http://etherscan.io/tx/${successTxHash}`}
                    >
                      Transaction successful
                    </Link>
                  </Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    TxHash: {successTxHash}
                  </Text>
                </>
              )}
              {rescuingState === TransferERC20Progress.Failed && (
                <>
                  <Text b type="error">
                    Transaction failed {failReason}
                  </Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    {failReasonVerbose}
                  </Text>
                </>
              )}
            </Col>
          </Row>
        </Col>
      </Row>
      <Spacer y={1} />
      <Row>
        <Col>
          <Button
            onClick={async () => {
              if (validateInputs()) {
                await rescueERC20();
              }
            }}
            disabled={true}
            type="secondary"
            style={{ width: "100%" }}
          >
            {isRescuing ? "Rescuing..." : "Rescue ERC20"}
          </Button>
        </Col>
      </Row>
    </Card>
  );
}
