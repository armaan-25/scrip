# CLI Styling Design

> **Implemented**, against the reshaped `scrip <noun> <verb>` CLI - see
> `bin/cli.ts`. The design below was written against the pre-pivot flat
> command list, but the styling approach (color only in `bin/cli.ts`,
> `src/cli.ts` untouched) never depended on which commands exist, so it
> applied unchanged. Verified with real ANSI codes confirmed present in
> the output (this sandboxed environment has no `TERM` set, so chalk's
> color detection reports level 0 by default here - verified instead by
> forcing `TERM=xterm-256color` and confirming real `\x1b[...m` escape
> sequences appear around the label text; a real user terminal always has
> `TERM` set and will render this in color with zero extra steps).

## Goal

Style the `scrip` CLI's terminal output with color (a Ramp-yellow accent
on monochrome text) and a small banner, without touching the tested core
that produces that output.

## Context (for an agent with no prior context on this repo)

`scrip` is a TypeScript/Node spend-enforcement system. It has a CLI at
`bin/cli.ts` (thin bootstrap: loads `.env`, builds a `ScripRuntime`, calls
`runCli`, prints the result or an error) and `src/cli.ts` (the tested
core: `export async function runCli(runtime: ScripRuntime, argv: string[]):
Promise<string>` — parses `argv`, dispatches to one of 5 commands
(`status`, `authorize`, `delegate`, `settle`, `revoke`), returns a
**plain-text, multi-line string** built from labeled fields like:

```
rampBudgetId: ramp-budget-research
monthlyLimit: $100.0000
reportedSpend: $0.0000
```

`tests/cli.test.ts` asserts on exact plain-text substrings of that return
value, e.g. `expect(output).toContain('rampBudgetId: ramp-budget-research')`.

## Constraint that shapes the whole design

**`src/cli.ts` / `runCli` must not change.** If color codes were injected
inside the returned string (e.g., coloring the label separately from the
value with two `chalk` calls concatenated by a space), the literal
substring `'rampBudgetId: ramp-budget-research'` would no longer appear
contiguously in the output (ANSI escape sequences would sit between the
label and value), breaking every existing test assertion for no real
benefit. Styling is a presentation concern; it belongs entirely in
`bin/cli.ts`, applied to the string `runCli` already returns, immediately
before printing it. This keeps `src/cli.ts` exactly as it is today and
requires zero test changes.

## Color

Ramp's real brand accent is `#E4F222` ("Ripe Lemon"), confirmed via
brandcolorcode.com and Ramp's own design system documentation (described
there as "a single highlighter-yellow signal against monochrome" — Ramp
uses this one yellow as an accent against black/white/gray, not a
multi-color palette). This design follows that same pattern: one yellow
accent color, everything else neutral (white/gray), no other hues.

## Package

**`chalk`** (v5, ESM-only — matches this project's `"type": "module"` in
`package.json` already, so no interop shim needed). Solves terminal color
formatting (wrapping text in the right ANSI escape codes, resetting them
correctly, no-color detection when output isn't a TTY). The alternative —
hand-writing raw ANSI escape sequences — means reimplementing and
maintaining what `chalk`'s small, well-tested API already does. Add it to
`dependencies` in `package.json`: `"chalk": "^5.3.0"`.

## Implementation

All changes are in `bin/cli.ts` only.

1. **Import chalk and define the accent color once:**

```typescript
import chalk from 'chalk';

const accent = chalk.hex('#E4F222');
```

2. **Print a small banner at the start of `main()`, before calling `runCli`:**

```typescript
console.log(accent.bold('▲ SCRIP'));
```

3. **Style the returned output line-by-line, right before printing it.**
   Add a helper function above `main()`:

```typescript
function styleOutput(output: string): string {
  return output
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)([^:]+):(\s.*)?$/);
      if (!match) return chalk.gray(line);
      const [, indent, label, rest] = match;
      return `${indent}${accent(label)}:${chalk.white(rest ?? '')}`;
    })
    .join('\n');
}
```

   This matches every line of the form `<label>: <value>` (including
   indented ones, like the `  claude-sonnet-5: 2 requests, ...` lines
   inside `settle`'s `modelUsage:` block) and colors the label yellow,
   the value white. Lines with no `:` (there currently are none in
   `runCli`'s output, but this is defensive) print in gray instead of
   crashing.

4. **Use it in `main()`, replacing the current `console.log(output)`:**

```typescript
async function main() {
  console.log(accent.bold('▲ SCRIP'));
  const runtime = new ScripRuntime(
    process.env.SCRIP_CONFIG ?? 'scrip.yaml',
    process.env.SCRIP_STORE ?? '.scrip/ramp.json',
    undefined,
    process.env.SCRIP_LEASE_STORE ?? '.scrip/leases.json'
  );
  const output = await runCli(runtime, process.argv.slice(2));
  console.log(styleOutput(output));
}
```

5. **Style the error path too, for consistency** (currently
   `console.error` with no color):

```typescript
main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(chalk.gray(error.message));
  } else {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
  process.exit(1);
});
```

## What doesn't change

- `src/cli.ts` — zero changes, `runCli`'s return value is exactly the
  same plain text as before.
- `tests/cli.test.ts` — zero changes; it tests `runCli` directly, never
  `bin/cli.ts`, so it's unaffected by anything printed to the terminal.
- No new test file — there is no existing test coverage for `bin/cli.ts`
  itself (same as `bin/mcp-server.ts`), and `styleOutput`'s correctness is
  easiest to confirm by eye in a real terminal (color is inherently a
  visual property), not worth a snapshot test for a 10-line helper.

## Verification

Run manually and eyeball it:

```bash
npm run cli -- status research
```

Expect: a yellow `▲ SCRIP` banner, then each `label: value` line with the
label in yellow and the value in white/gray.

```bash
npm run cli -- status not-a-real-budget
```

Expect: the banner, then the error line in red.

## Out of scope

- Boxed sections, tables, spinners, ASCII-art banners (`boxen`,
  `cli-table3`, `figlet`, `ora`) — explicitly deferred; this is a small
  color-and-banner pass, not a full TUI overhaul.
- Auto-detecting/disabling color for non-TTY output — `chalk` already
  handles this itself (it detects `process.stdout.isTTY` and strips
  color codes automatically when piped), so no extra code is needed.
