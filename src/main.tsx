import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./windowInit"; // kick off window-state restoration as early as possible

// Block WebView page-reload shortcuts (Ctrl+R / F5) to prevent accidental disconnect.
// Registered in capture phase so it fires before native WebView handling.
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") e.preventDefault();
  if (e.key === "F5") e.preventDefault();
}, true);

// Disable the browser's built-in right-click context menu globally.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
