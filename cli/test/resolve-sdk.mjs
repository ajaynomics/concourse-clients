// Tests run the shared Pi source in place. Resolve its A2A SDK import from this
// package, as the built files do, so the CLI never borrows the Pi install.
import { registerHooks } from "node:module";

const parentURL = new URL("../package.json", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => next(specifier, specifier === "@a2a-js/sdk" || specifier.startsWith("@a2a-js/sdk/") ? { ...context, parentURL } : context),
});
