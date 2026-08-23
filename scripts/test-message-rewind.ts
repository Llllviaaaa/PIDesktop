import registerDesktopGuard, {
  PIDESKTOP_MODE_COMMAND,
  PIDESKTOP_PERMISSION_COMMAND,
  PIDESKTOP_REWIND_COMMAND,
} from "../src-tauri/resources/pidesktop-guard.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type CommandHandler = (args: string, context: Record<string, unknown>) => Promise<void>;
const commandHandlers = new Map<string, CommandHandler>();

registerDesktopGuard({
  registerCommand(name: string, options: { handler: CommandHandler }) {
    commandHandlers.set(name, options.handler);
  },
  on() {},
  sendMessage() {},
} as never);

const commandHandler = commandHandlers.get(PIDESKTOP_REWIND_COMMAND);
assert(commandHandler, "desktop rewind command has a handler");
assert(commandHandlers.has(PIDESKTOP_MODE_COMMAND), "desktop agent-mode command is registered");
assert(commandHandlers.has(PIDESKTOP_PERMISSION_COMMAND), "desktop permission command is registered");

let navigatedTo = "";
let summarize: boolean | undefined;
await commandHandler("user-entry", {
  sessionManager: {
    getEntry: (entryId: string) => entryId === "user-entry"
      ? { type: "message", message: { role: "user", content: "before" } }
      : undefined,
    getBranch: () => [{ id: "user-entry" }],
  },
  navigateTree: async (entryId: string, options: { summarize?: boolean }) => {
    navigatedTo = entryId;
    summarize = options.summarize;
    return { cancelled: false };
  },
});
assert(navigatedTo === "user-entry", "rewind navigates to the selected user entry");
assert(summarize === false, "rewind does not summarize the abandoned branch");

let invalidRejected = false;
try {
  await commandHandler("assistant-entry", {
    sessionManager: {
      getEntry: () => ({ type: "message", message: { role: "assistant", content: "after" } }),
    },
    navigateTree: async () => ({ cancelled: false }),
  });
} catch {
  invalidRejected = true;
}
assert(invalidRejected, "rewind rejects non-user entries");

let abandonedBranchRejected = false;
try {
  await commandHandler("user-entry", {
    sessionManager: {
      getEntry: () => ({ type: "message", message: { role: "user", content: "before" } }),
      getBranch: () => [{ id: "other-entry" }],
    },
    navigateTree: async () => ({ cancelled: false }),
  });
} catch {
  abandonedBranchRejected = true;
}
assert(abandonedBranchRejected, "rewind rejects user messages outside the active branch");

let cancellationRejected = false;
try {
  await commandHandler("user-entry", {
    sessionManager: {
      getEntry: () => ({ type: "message", message: { role: "user", content: "before" } }),
      getBranch: () => [{ id: "user-entry" }],
    },
    navigateTree: async () => ({ cancelled: true }),
  });
} catch {
  cancellationRejected = true;
}
assert(cancellationRejected, "rewind cancellation is surfaced to the caller");

console.log("message-rewind: all assertions passed");
