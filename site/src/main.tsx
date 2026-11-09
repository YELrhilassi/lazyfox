import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// The built page arrives prerendered (scripts/prerender.mjs), so the markup the
// browser already painted is the markup React takes over. In dev the container
// holds only the placeholder comment from index.html, which is not an element
// and therefore not something to hydrate.
if (container.firstElementChild) hydrateRoot(container, app);
else createRoot(container).render(app);
