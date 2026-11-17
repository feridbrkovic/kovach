import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./api";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

connect().then(({ api, agent, source }) => {
  root.render(
    <StrictMode>
      <App api={api} agent={agent} source={source} />
    </StrictMode>,
  );
});
