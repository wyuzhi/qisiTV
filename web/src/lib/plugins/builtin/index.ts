import "./editor/editor-shell";
import { syncActiveClientPlugins } from "../plugin-client-loader";

// Start loading enabled client packages immediately once registered builtins settle.
syncActiveClientPlugins();
