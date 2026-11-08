import { renderToString } from "react-dom/server";
import App from "./App";

// Built by `vite build --ssr` and consumed by scripts/prerender.mjs. Anything
// added here has to render identically in the browser, or hydration would
// rewrite the page the crawler just read.
export function render(): string {
  return renderToString(<App />);
}
