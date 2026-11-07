import { parseArgs } from "node:util";

import { backtestCommand } from "./commands/backtest.ts";
import { forgetCommand } from "./commands/forget.ts";
import { listCommand, panicCommand, statusCommand, stopCommand } from "./commands/manage.ts";
import { runCommand } from "./commands/run.ts";
import { validateCommand } from "./commands/validate.ts";
import { useEgress } from "./egress.ts";
import { c } from "./print.ts";

// A bot started by the dashboard API sends its SoDEX traffic from the address it was given.
useEgress(process.env.SODEXTRA_EGRESS_IP);

const HELP = `Sodextra bot runner

  npm run bot -- validate <bot.json>              check a config against live market data (signs nothing)
  npm run bot -- backtest <bot.json> [--days 7]   simulate on recent 1-minute candles
  npm run bot -- paper    <bot.json>              live prices, simulated orders
  npm run bot -- live     <bot.json> --confirm    real orders with your API key (needs "risk.maxNotional" in the bot file)
  npm run bot -- status   [bot.json]              saved state, orders and recent events
  npm run bot -- stop     <bot.json> [--close] [--paper]
                                                  cancel the bot's orders (--close also closes its position)
  npm run bot -- panic    [--close]               cancel ALL Sodextra orders on your account
  npm run bot -- list                             every bot in .sodextra/sodextra.db
  npm run bot -- forget   <name|id> [--id <id>] [--confirm]
                                                  delete a stopped bot and its history (nothing on SoDEX changes)
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      confirm: { type: "boolean", default: false },
      close: { type: "boolean", default: false },
      paper: { type: "boolean", default: false },
      days: { type: "string", default: "7" },
      id: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, file] = positionals;
  const needFile = (): string => {
    if (!file) throw new Error(`"${command}" needs a bot file, e.g. bots/example-probe.json`);
    return file;
  };

  switch (values.help ? "help" : command) {
    case "validate":
      return validateCommand(needFile());
    case "backtest":
      return backtestCommand(needFile(), Number(values.days));
    case "paper":
      return runCommand(needFile(), "paper", true);
    case "live":
      return runCommand(needFile(), "live", values.confirm);
    case "status":
      return statusCommand(file);
    case "stop":
      return stopCommand(needFile(), { close: values.close, paper: values.paper });
    case "panic":
      return panicCommand({ close: values.close });
    case "list":
      return listCommand();
    case "forget":
      if (!file) throw new Error('"forget" needs a bot name or id');
      return forgetCommand(file, { confirm: values.confirm, id: values.id });
    default:
      console.log(HELP);
      return command === undefined || command === "help" || values.help ? 0 : 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(c.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  });
