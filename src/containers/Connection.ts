import { useState, useEffect } from "react";
import { createContainer } from "unstated-next";
import { ethers } from "ethers";
import { Observable } from "rxjs";
import { debounceTime } from "rxjs/operators";

type Provider = ethers.providers.Web3Provider;
type Network = ethers.providers.Network;

declare global {
  interface Window {
    ethereum: any | undefined;
  }
}

function useConnection() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [blockNum, setBlockNum] = useState<number | null>(null);

  const attemptConnection = async () => {
    if (window.ethereum === undefined) {
      throw Error("MetaMask not found, please visit https://metamask.io/");
    }

    // get provider, address, and network
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    const network = await provider.getNetwork();

    // make sure page refreshes when network is changed
    // https://github.com/MetaMask/metamask-extension/issues/8226
    window.ethereum.on("chainIdChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());

    // set states
    setSigner(signer);
    setProvider(provider);
    setAddress(address);
    setNetwork(network);
  };

  const connect = async () => {
    try {
      await attemptConnection();
      window.ethereum.on("accountsChanged", () => attemptConnection());
    } catch (error) {
      console.error(error);
      alert(error.message);
    }
  };

  const checkAndConnect = async () => {
    if (window?.ethereum?.request) {
      const availableAccounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      if (availableAccounts.length > 0) {
        connect();
      }
    }
  };

  useEffect(() => {
    // connect if we already have metamask approval
    try {
      checkAndConnect();
    } catch (e) {
      console.error(e);
    }
    // eslint-disable-next-line
  }, []);

  // create observable to stream new blocks
  useEffect(() => {
    if (provider) {
      const observable = new Observable<number>((subscriber) => {
        provider.on("block", (blockNumber: number) =>
          subscriber.next(blockNumber)
        );
      });
      // debounce to prevent subscribers making unnecessary calls
      observable.pipe(debounceTime(1000)).subscribe((blockNumber) => {
        // Update every 5 blocks otherwise its very laggy
        if (blockNumber > (blockNum || 0) + 5) {
          setBlockNum(blockNumber);
        }
      });
    }
    // eslint-disable-next-line
  }, [provider]);

  return {
    connect,
    provider,
    address,
    network,
    blockNum,
    signer,
  };
}

export const Connection = createContainer(useConnection);
