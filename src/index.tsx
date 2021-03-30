import React from "react";
import ReactDOM from "react-dom";
import "./index.css";
import App from "./App";
import { GeistProvider, CssBaseline } from "@geist-ui/react";
import reportWebVitals from "./reportWebVitals";

import { Connection } from "./containers/Connection";

ReactDOM.render(
  <React.StrictMode>
    <GeistProvider>
      <CssBaseline />
      <Connection.Provider>
        <App />
      </Connection.Provider>
    </GeistProvider>
  </React.StrictMode>,
  document.getElementById("root")
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
