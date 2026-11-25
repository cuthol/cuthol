import test from "node:test";
import assert from "node:assert/strict";
import { printHelp } from "../cli_help.js";
import { runCli } from "../cli_main.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

const NESTED: Array<{ words: string[]; actions: string[] }> = [
  { words: ["spine", "fx"], actions: ["catalog", "add", "set", "remove", "list", "try", "check", "preset"] },
  { words: ["spine", "envelope", "point"], actions: ["add", "move", "remove"] },
  { words: ["workspace", "journal"], actions: ["list", "undo", "redo", "tag"] },
  { words: ["workspace", "changes"], actions: ["show", "adopt", "revert"] },
];

test("w0afix: every nested group --help lists its actions with summaries", () => {
  for (const { words, actions } of NESTED) {
    const [group, action, ...rest] = words;
    const out = captureStdout(() => printHelp(group, action, rest));
    assert.ok(out.length > 0, `${words.join(" ")}: empty --help`);
    for (const sub of actions) {
      assert.ok(out.includes(`  ${sub} \u2014 `), `${words.join(" ")}: --help misses action ${sub}:\n${out}`);
    }
    assert.ok(!out.includes("Global output flags"), `${words.join(" ")}: fell back to global usage text`);
  }
});

test("w0afix: exact nested actions still print their own flags", () => {
  const fxAdd = captureStdout(() => printHelp("spine", "fx", ["add"]));
  assert.ok(fxAdd.includes("--item"), `spine fx add --help misses --item:\n${fxAdd}`);
  const pointAdd = captureStdout(() => printHelp("spine", "envelope", ["point", "add"]));
  assert.ok(pointAdd.includes("--at"), `spine envelope point add --help misses --at:\n${pointAdd}`);
  const undo = captureStdout(() => printHelp("workspace", "journal", ["undo"]));
  assert.ok(undo.length > 0, "workspace journal undo --help is empty");
  const show = captureStdout(() => printHelp("workspace", "changes", ["show"]));
  assert.ok(show.length > 0, "workspace changes show --help is empty");
});

test("w0afix: G110 drops the prefix for descriptive suggestions, keeps it for bare commands", async () => {
  await assert.rejects(() => runCli(["library", "ingest", "--files", "a.mp4"]), (err: unknown) => {
    const text = String((err as Error).message);
    return (
      text.includes("[CUTHOL-G110]") &&
      text.includes("`--files` is not a flag of `library ingest`") &&
      text.includes("files are positional") &&
      !text.includes("Use this command:")
    );
  });

  await assert.rejects(
    () => runCli(["spine", "trim", "--clip", "sp_01", "--inn", "1s"]),
    (err: unknown) => {
      const text = String((err as Error).message);
      return (
        text.includes("[CUTHOL-G110]") &&
        text.includes("`--inn` is not a flag of `spine trim`") &&
        text.includes("did you mean `--in`?") &&
        !text.includes("Use this command:")
      );
    }
  );

  const bare = DIAGNOSTICS.UNKNOWN_FLAG("--nope", "mix.normalize", "cuthol mix normalize --help").formatted;
  assert.ok(bare.includes("Use this command: cuthol mix normalize --help"), `bare command lost its prefix:\n${bare}`);
});
