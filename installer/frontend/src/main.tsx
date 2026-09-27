import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) {
  throw new Error("the installer window has no mount point");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
