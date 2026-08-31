import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/space-grotesk";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";

// Pas de StrictMode : le double montage en dev ouvrirait deux shells SSH.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
