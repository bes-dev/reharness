# Mobile App Generator

Generate Expo React Native apps from a text description using a multi-agent pipeline.

Built on [reharness](../../README.md) — FSM orchestration, Pi agents for code generation.

## Pipeline

```
scaffold → prd → skeleton → logic → ui → verify ↔ fix → complete
                                              ↘ error (after 3 fix attempts)
```

| State | Type | What it does |
|-------|------|-------------|
| scaffold | Code | create-expo-app, install deps, write configs |
| prd | Agent | Generate PRD with Entity-Action Matrix |
| skeleton | Agent | Design type contracts with JSDoc (frozen after this) |
| logic | Agent | Implement services + stores against contracts |
| ui | Agent | Build components + screens with charts/calendar support |
| verify | Code | tsc + bundle + smoke test (simulator) + stubs + antipatterns |
| fix | Agent | Read verify-report.md, fix exact errors (up to 3 attempts) |
| complete | Final | BUILD COMPLETE |
| error | Final | Could not fix after 3 attempts |

## Usage

```bash
cd examples/mobile-app-generator
reharness                           # List available commands
reharness build feedwise "RSS reader with bookmarks"  # Direct run
```

Commands:

```
/build <slug> <idea...>              Build a new app
/improve <slug> <request...>         Modify an existing app
/build <slug> <idea...> --resume     Resume interrupted build
```

Then run the app:

```bash
cd apps/feedwise && npx expo start
```

## Project Structure

```
.reharness/
├── agents/              # Agent prompts
│   ├── prd.md           # PRD generation
│   ├── skeleton.md      # Type-level API design
│   ├── logic.md         # Service + store implementation
│   ├── ui.md            # Components + screens (473 lines)
│   ├── fix.md           # Build error fixes
│   └── improve.md       # Modify existing app
├── commands/
│   ├── build.ts         # /build — full FSM pipeline
│   └── improve.ts       # /improve — modify + verify + fix
└── lib/
    ├── scaffold.ts      # Expo project creation
    └── smoke.ts         # Runtime smoke test via iOS Simulator
```

## Tech Stack (pre-installed by scaffold)

- **Expo** + Expo Router + TypeScript
- **React Native Paper** — standard UI components (MD3)
- **react-native-gifted-charts** — bar, line, pie, donut charts
- **react-native-calendars** — month view, date marking, agenda
- **react-native-svg** — custom visualizations, progress rings
- **Zustand** — state management
- **AsyncStorage** — persistence

## Verify Pipeline

5 checks, each writes to `verify-report.md` on failure → fix agent reads exact errors:

1. **tsc** — TypeScript type checking
2. **bundle** — `npx expo export` catches import/bundling errors
3. **smoke** — Launch app in iOS Simulator, check Metro log for runtime errors (TypeError, Invariant Violation)
4. **stubs** — grep for TODO, STUB, FIXME, `throw "skeleton"`
5. **antipatterns** — app.json exists, App.tsx exists, deprecated SafeAreaView

## Requirements

- Node.js 20+, macOS with Xcode (for smoke test simulator)
- [Pi coding agent](https://github.com/badlogic/pi-mono): `npm i -g @mariozechner/pi-coding-agent`
- LLM server (LM Studio with 27B+ model, or any OpenAI-compatible)

### Pi Setup

Pi needs the `brave-search` skill for PRD research:

```json
// ~/.pi/agent/settings.json
{ "packages": ["pi-skills"] }
```

## Architecture

Each agent sees ONLY its own prompt + files on disk. No shared context between agents. Types with JSDoc are the contract between skeleton → logic → ui.
