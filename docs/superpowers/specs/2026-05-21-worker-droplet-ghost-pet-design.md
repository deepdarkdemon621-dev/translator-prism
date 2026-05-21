# Worker Droplet Ghost Pet Design

## Goal

Add a small animated command-line pet to the worker terminal experience. The pet should look like a droplet-shaped ghost, animate through a small set of random actions, and stay out of the way of worker logs and long-running translation work.

## User Experience

When the worker starts in an interactive terminal, it starts a lightweight pet renderer. The pet occupies a compact block of terminal output and periodically changes pose. The baseline shape is a soft droplet ghost:

```text
   .
  / \
 /   \
( o o )
 \ ^ /
  \_/
 '~~~'
```

The pet randomly performs actions such as:

- `float`: shift left and right slightly.
- `blink`: close and reopen its eyes.
- `working`: show focused eyes and a small progress cue.
- `thinking`: show a question mark above the head.
- `sleep`: close eyes and show a `z`.
- `cheer`: raise small side arms.
- `error`: show startled eyes and a short shake.
- `hide`: compress into a smaller droplet and pop back out.

The animation should feel alive without taking over the terminal. Each action should be short, with a random delay between actions so the output does not feel mechanical.

## Architecture

Create `worker/pet.ts` as the isolated pet module. It should export a single worker-facing API, such as `startWorkerPet()`, and keep animation details private.

`worker/index.ts` should only initialize the pet near worker startup. The worker's database, queue, locking, and translation logic should not depend on pet internals.

The pet module owns:

- Frame definitions for each action.
- Random action selection.
- Timer lifecycle.
- Terminal capability checks.
- Environment-variable enable/disable behavior.

## Terminal Behavior

The pet should animate only when terminal output is interactive enough to support it. In non-TTY contexts, CI, or normal log capture, it should degrade to minimal output or stay silent so PM2 and log files are not filled with animation frames.

Environment controls:

- `WORKER_PET=0`: disable the pet.
- `WORKER_PET=1`: force-enable the pet.
- unset: enable only when `process.stdout.isTTY` is true and `CI` is not set.

Interactive mode may use ANSI cursor movement to redraw the pet in place. It should avoid clearing the whole screen and should not hide normal worker logs.

## Worker Events

The first implementation can run mostly independently on a timer. It may expose a small event API later, but the initial scope should keep worker integration small.

Optional light integration:

- Startup favors an idle or float action.
- Translation activity can bias toward `working`.
- Failure logs can trigger `error`.

These event hooks are useful but not required for the first pass if they add too much coupling.

## Error Handling

The pet must never crash the worker. Terminal rendering errors, invalid environment values, or timer cleanup issues should be swallowed or handled locally. Worker shutdown should stop timers if the module exposes a stop function.

## Testing

Focused tests should cover:

- `WORKER_PET=0` disables rendering.
- Default enablement respects TTY and CI conditions.
- Each action has non-empty frames.
- Random action selection returns a known action.

Tests should avoid requiring a real terminal. Pure functions for capability detection and frame selection should be testable without running the animation loop.

## Non-Goals

- No image assets.
- No external animation dependencies.
- No full-screen terminal UI.
- No changes to translation behavior, database schema, or Next.js application routes.
