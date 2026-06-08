import type {
  StateDefinition, FinalState, ApprovalState, SwitchState, ParallelState, LoopState, CallState, WaitState,
} from "./types.js";

// Discriminate the StateDefinition variants. Foundational predicates shared by the validator, the workspace
// addressing, and the transducer — one source so the variant set can't drift between consumers.

export const isFinal = <C extends Record<string, any>>(s: StateDefinition<C>): s is FinalState<C> =>
  "type" in s && s.type === "final";
export const isApproval = <C extends Record<string, any>>(s: StateDefinition<C>): s is ApprovalState<C> =>
  "type" in s && s.type === "approval";
export const isSwitch = <C extends Record<string, any>>(s: StateDefinition<C>): s is SwitchState<C> =>
  "type" in s && s.type === "switch";
export const isParallel = <C extends Record<string, any>>(s: StateDefinition<C>): s is ParallelState<C> =>
  "type" in s && s.type === "parallel";
export const isLoop = <C extends Record<string, any>>(s: StateDefinition<C>): s is LoopState<C> =>
  "type" in s && s.type === "loop";
export const isCall = <C extends Record<string, any>>(s: StateDefinition<C>): s is CallState<C> =>
  "type" in s && s.type === "call";
export const isWait = <C extends Record<string, any>>(s: StateDefinition<C>): s is WaitState<C> =>
  "type" in s && s.type === "wait";
