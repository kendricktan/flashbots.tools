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
import { TransferENS } from "./engine/TransferENS";
import { parseUnits } from "ethers/lib/utils";

export enum TransferENSProgress {
  NotStarted,
  GetWETH,
  ApproveContract,
  SignTransaction,
  BroadcastingTransaction,
  Success,
  Failed,
}

export function ENS({
  blocksInTheFuture,
  relayerURL,
}: {
  blocksInTheFuture: string;
  relayerURL: string;
}) {
  const { provider, signer } = Connection.useContainer();

  const [compromisedPrivateKey, setCompromisedPrivateKey] = useState("");
  const [ensDomain, setENSAddress] = useState("");
  const [newENSOwner, setENSRecipient] = useState("");
  const [ethBribeAmount, setEthBribeAmount] = useState("0.05");
  const [rescuingState, setRescuingState] = useState<TransferENSProgress>(
    TransferENSProgress.NotStarted
  );

  // eslint-disable-next-line
  const [_, setThreadId] = useState<NodeJS.Timeout | null>(null);

  const [invalidPrivateKey, setInvalidPrivateKey] = useState(false);
  const [invalidENSRecipient, setInvalidENSRecipient] = useState(false);

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

    if (!ethers.utils.isAddress(newENSOwner)) {
      setInvalidENSRecipient(true);
      valid = false;
    } else {
      setInvalidENSRecipient(false);
    }

    return valid;
  };

  const rescueENS = async () => {
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
        setRescuingState(TransferENSProgress.GetWETH);
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
        setRescuingState(TransferENSProgress.ApproveContract);
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
      const engine = new TransferENS(
        provider,
        walletZeroGas,
        signer,
        ensDomain,
        newENSOwner
      );

      let zeroGasTxs: FlashbotsBundleTransaction[];
      try {
        zeroGasTxs = await engine.getZeroGasPriceTx();
      } catch (e) {
        console.log(`Error: ${e.toString()}`);
        setRescuingState(TransferENSProgress.Failed);
        setFailReason("Failed to construct ENS transfer tx");
        setFailReasonVerbose(e.toString());
        return;
      }

      setRescuingState(TransferENSProgress.SignTransaction);
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
        setRescuingState(TransferENSProgress.Failed);
        setFailReason(
          "Simulation failed, perhaps a non standard ENS transfer?"
        );
        setFailReasonVerbose(e.toString());
        return;
      }

      setBroadcastAttempts(0);
      setRescuingState(TransferENSProgress.BroadcastingTransaction);

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
          setRescuingState((prevState: TransferENSProgress) => {
            // Only update if we've succeeded
            if (prevState === TransferENSProgress.BroadcastingTransaction) {
              return TransferENSProgress.Failed;
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
          setRescuingState((prevState: TransferENSProgress) => {
            // Only update if we've succeeded
            if (prevState === TransferENSProgress.BroadcastingTransaction) {
              return TransferENSProgress.Success;
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
          setRescuingState((prevState: TransferENSProgress) => {
            // Only update if we've succeeded
            if (prevState === TransferENSProgress.BroadcastingTransaction) {
              return TransferENSProgress.Failed;
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
    rescuingState === TransferENSProgress.NotStarted ||
    rescuingState === TransferENSProgress.Failed ||
    rescuingState === TransferENSProgress.Success
  );

  return (
    <Card shadow>
      <Text h3>Gasless ENS Transfers</Text>
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
                  "Private key who owns the ENS domain, but does not have Ether"
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
            value={ensDomain}
            onChange={(e) => setENSAddress(e.target.value)}
            placeholder="alice.eth"
            width="100%"
          >
            <Text h5>
              ENS Domain&nbsp;
              <Tooltip
                type="secondary"
                text={"ENS domain name. e.g. alice.eth"}
              >
                <QuestionCircle size={15} />
              </Tooltip>
            </Text>
          </Input>

          <Spacer y={1} />
          <Input
            status={invalidENSRecipient ? "error" : "default"}
            value={newENSOwner}
            onChange={(e) => setENSRecipient(e.target.value)}
            placeholder="ens recipient address"
            width="100%"
          >
            <Text h5>
              New ENS Owner Address&nbsp;
              <Tooltip type="secondary" text={"New owner of the ENS domain"}>
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
              {rescuingState === TransferENSProgress.NotStarted && (
                <>
                  <Text b>Rescue your ENS from a compromised wallet!</Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    Note: Connected metamask account will be paying for the
                    bribes
                  </Text>
                </>
              )}
              {rescuingState === TransferENSProgress.GetWETH && (
                <>
                  <Text b>Wrapping {ethBribeAmount} ETH into WETH</Text>
                  <Spacer y={0.1} />
                  <Text small type="secondary">
                    1/3
                  </Text>
                  <Loading />
                </>
              )}
              {rescuingState === TransferENSProgress.ApproveContract && (
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
              {rescuingState === TransferENSProgress.SignTransaction && (
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
                TransferENSProgress.BroadcastingTransaction && (
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
              {rescuingState === TransferENSProgress.Success && (
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
              {rescuingState === TransferENSProgress.Failed && (
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
                await rescueENS();
              }
            }}
            disabled={!(provider && signer) || isRescuing}
            type="secondary"
            style={{ width: "100%" }}
          >
            {isRescuing ? "Rescuing..." : "Rescue ENS"}
          </Button>
        </Col>
      </Row>
    </Card>
  );
}
