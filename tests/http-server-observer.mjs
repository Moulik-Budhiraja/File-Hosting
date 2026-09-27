// Test-only observation of the real HTTP server, including Next's generated
// entrypoint. Never loaded by the production command.
import { Server } from "node:http";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  // Shorten an existing deadline only, to reproduce the old failure without
  // waiting five minutes. A disabled deadline stays disabled.
  if (process.env.FS_TEST_SHORT_DEADLINE === "1") {
    if (this.requestTimeout !== 0) this.requestTimeout = 1000;
    // Node swaps nonzero header/request limits when headers > request.
    // Scale the header deadline too; complete headers are sent immediately.
    this.headersTimeout = 200;
    this.connectionsCheckingInterval = 50;
  }
  this.once("listening", () => {
    process.send?.({
      type: "http-server",
      address: this.address(),
      timeouts: Object.fromEntries(
        [
          "requestTimeout",
          "headersTimeout",
          "timeout",
          "keepAliveTimeout",
          "keepAliveTimeoutBuffer",
          "connectionsCheckingInterval",
        ].map((name) => [name, this[name]]),
      ),
    });
  });
  return Reflect.apply(listen, this, args);
};
