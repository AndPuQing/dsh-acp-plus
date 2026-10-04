// src/app.ts
import { Command } from "commander";
import { exitOnStdinEnd, parseCmdline } from "@deepseek-ai/dsh-cmdline";
var name = "acp-plus-startup";
var inject = ["cmdlineArgs"];
var ACP_EXT_STARTUP_SERVICE = "acpPlusStartup";
function acpPlusCommand() {
  return new Command().name("dsh --profile acp-plus").description("Serve automation clients over the extended Agent Client Protocol stdio bridge.").helpOption("-h, --help", "show this help").addHelpText("after", `
Example:
  dsh --profile acp-plus     serve ACP until the client disconnects
`);
}
function apply(ctx) {
  const program = acpPlusCommand();
  program.action(() => {
    exitOnStdinEnd(ctx, "acp-plus.stdin");
    ctx.provide(ACP_EXT_STARTUP_SERVICE, { accepted: true });
  });
  parseCmdline(ctx, program);
}
export {
  ACP_EXT_STARTUP_SERVICE,
  apply,
  inject,
  name
};
//# sourceMappingURL=app.js.map
