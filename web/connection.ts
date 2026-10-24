import { createContext } from "react";
// Suspending a native dialog releases the top layer without losing its React draft.
export const ConnectionBlocked = createContext(false);
