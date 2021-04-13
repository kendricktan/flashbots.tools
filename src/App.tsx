import {
  Page,
  Link,
  Button,
  Spacer,
  Text,
  Input,
  Modal,
  useModal,
  Tabs,
} from "@geist-ui/react";
import Settings from "@geist-ui/react-icons/settings";

import { useState } from "react";
import { Connection } from "./containers/Connection";
import { ENS } from "./ENS";

import { ERC20 } from "./ERC20";

function App() {
  const { address, connect } = Connection.useContainer();

  const { setVisible: setModalVisible, bindings: modalBindings } = useModal();

  const [relayerURL, setRelayerURL] = useState("http://3.238.87.202");
  const [blocksInTheFuture, setBlocksInTheFuture] = useState("2");

  return (
    <>
      <Modal {...modalBindings}>
        <Modal.Title>Settings</Modal.Title>
        <Modal.Content>
          <Input
            value={relayerURL}
            onChange={(e) => setRelayerURL(e.target.value)}
            width="100%"
          >
            <Text h5>Flashbots Relayer URL</Text>
          </Input>
          <Spacer y={1} />
          <Input
            value={blocksInTheFuture}
            onChange={(e) => setBlocksInTheFuture(e.target.value)}
            width="100%"
          >
            <Text h5>Blocks In The Future</Text>
          </Input>
        </Modal.Content>
        <Modal.Action onClick={() => setModalVisible(false)}>
          Close
        </Modal.Action>
      </Modal>
      <Page>
        <div style={{ width: "100%", textAlign: "right" }}>
          <Button auto onClick={connect} size="small">
            {address
              ? address.slice(0, 6) + "..." + address.slice(-4)
              : "Connect"}
          </Button>
          &nbsp;&nbsp;&nbsp;&nbsp;
          <Button
            onClick={() => setModalVisible(true)}
            iconRight={<Settings />}
            auto
            size="small"
          />
        </div>

        <Spacer y={1} />
        <Text h2>Flashbots.tools</Text>
        <Text type="secondary">
          Made by{" "}
          <Link color href="https://twitter.com/kendrick_tn">
            @kendrick_tn
          </Link>
          &nbsp;|&nbsp;
          <Link color href="https://github.com/kendricktan/flashbots.tools">
            Source code
          </Link>
        </Text>
        <Spacer y={1} />

        <Tabs initialValue="1">
          <Tabs.Item label="ERC20" value="1">
            <ERC20
              relayerURL={relayerURL}
              blocksInTheFuture={blocksInTheFuture}
            />
          </Tabs.Item>
          <Tabs.Item label="ENS" value="2">
            <ENS
              relayerURL={relayerURL}
              blocksInTheFuture={blocksInTheFuture}
            />
          </Tabs.Item>
        </Tabs>
      </Page>
    </>
  );
}

export default App;
