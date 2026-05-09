export interface SkeletonState {
  type: "agent" | "code" | "final";
  status?: "success" | "error";
  on?: Record<string, string | GuardedTransition[]>;
}

export interface GuardedTransition {
  target: string;
  guard?: string;
}

export interface SkeletonJSON {
  id: string;
  description: string;
  usage: string;
  initial: string;
  states: Record<string, SkeletonState>;
}

export function validateSkeleton(skeleton: SkeletonJSON): string[] {
  const errors: string[] = [];
  const stateNames = new Set(Object.keys(skeleton.states));

  if (!skeleton.id) errors.push("Missing 'id'");
  if (!skeleton.description) errors.push("Missing 'description'");
  if (!skeleton.initial) errors.push("Missing 'initial'");
  if (!stateNames.has(skeleton.initial)) errors.push(`Initial state '${skeleton.initial}' does not exist`);

  let hasFinal = false;

  for (const [name, state] of Object.entries(skeleton.states)) {
    if (state.type === "final") {
      hasFinal = true;
      if (!state.status) errors.push(`Final state '${name}' missing 'status'`);
      continue;
    }

    if (!state.on || Object.keys(state.on).length === 0) {
      errors.push(`Non-final state '${name}' has no transitions`);
      continue;
    }

    for (const [event, target] of Object.entries(state.on)) {
      if (typeof target === "string") {
        if (!stateNames.has(target)) errors.push(`State '${name}' event '${event}' → '${target}' does not exist`);
      } else if (Array.isArray(target)) {
        for (const gt of target) {
          if (!stateNames.has(gt.target)) errors.push(`State '${name}' event '${event}' → '${gt.target}' does not exist`);
          if (gt.guard && !/^retries:\w+<\d+$/.test(gt.guard)) {
            errors.push(`State '${name}' guard '${gt.guard}' invalid format (expected 'retries:key<N')`);
          }
        }
      }
    }
  }

  if (!hasFinal) errors.push("No final state defined");

  return errors;
}
