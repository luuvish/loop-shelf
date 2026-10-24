import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";
import { startPwa } from "./pwa.ts";

void startPwa().catch(() => { /* App remains usable if browser storage is unavailable. */ });
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
