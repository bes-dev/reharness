# Design: Automatic Harness Synthesis — Theory & Algorithm

Status: **draft / theory proposal** · Companion to `per-agent-harness.md`
(which covers the lowering mechanics). This document answers: *on what theoretical
basis does the compiler **construct** a per-leaf harness, and what can it prove?*

---

## 0. The question

`per-agent-harness.md` shows Pi exposes the full harness surface as per-process
flags. That is the *target*. This document is the *source side*: given an agent
leaf with a behavioural `<contract>`, **how does the compiler decide its harness,
and what is provable about that decision?**

We want this to be a *named restriction of a standard model*, like the rest of
reharness (runtime = Moore transducer; analyzer = Kam–Ullman; dataflow =
polyhedral). The right standard model here is **type-and-effect inference**, paired
with **capability-based least privilege** and a **minimum set-cover** lowering.

---

## 1. Theoretical foundation

### 1.0 Harness is a LOCAL property of a leaf

The governing fact, which shapes everything below: **a leaf's harness depends only
on that leaf's own contract (its goal and task) — not on the shape of the FSM.**
Whether an agent needs the network, a shell, or git is a property of *what it is
asked to do*, readable from its `<contract>` alone. Two leaves with identical
contracts get identical harnesses regardless of where they sit in the graph.

This has a sharp consequence for the theory: harness synthesis is a **per-node,
intra-term inference**, not a global graph analysis. It does **not** propagate
effects across edges (unlike a classical call-graph effect system, where a
function's effect is the union of its callees'). A leaf is a self-contained unit
*(contract + harness + validator)*; the factory assembles a system out of
independently-correct units. This is the same locality the project already relies on
for `fill_prompts` (per-node, from the contract), and it is *unlike* the analyzer's
reachability/dataflow passes, which are inherently global.

> **Mounting ⊥ capability.** The one place topology *does* touch a leaf is which
> upstream *directories* are mounted into it — that is `visibleProducers`
> (`inputs`/`inputLists`), already implemented, and it answers *"what is visible"*.
> Harness answers a different question, *"what may it do"* (which tools/effects),
> and that is local. The two are orthogonal: a leaf reads files with the same
> `read` tool no matter which producer's directory is mounted.

### 1.1 Harness synthesis *is* (local) effect inference

In a **type-and-effect system** (Gifford & Lucassen 1986; Talpin & Jouvelot 1992;
Nielson & Nielson), a term has not only a type but an **effect**: a static
description of what it *does to the world* (reads store, writes store, does I/O,
diverges…). Effects are drawn from an **effect lattice** and inferred.

We use the *single-term* fragment of this theory: infer the effect of one leaf from
its contract, with **no inter-procedural propagation** (§1.0). The mapping to our
problem is exact:

| Type-and-effect system | reharness harness synthesis |
|---|---|
| term | agent leaf |
| latent type | the `<contract>` (what it returns / its output schema) |
| **latent effect** | **what the agent does to the world** (reads files, fetches web, runs git…) |
| effect lattice | the capability lattice (§1.2) |
| effect inference | harness synthesis |
| effect *masking* / privilege | least-privilege capability cover (§1.3) |
| soundness: effects ⊆ declared | harness sufficiency (§4 — partial) |

So **synthesizing a harness = inferring the agent's effect, then realizing the
least environment that affords it.** This is not a metaphor; it is the same
problem statement with "process spawned with capabilities" in place of "expression
evaluated in a region".

### 1.2 The capability lattice

Let $\mathcal{E}$ be a fixed, finite **effect alphabet** — the kinds of world-effect
a leaf can have:
$$
\mathcal{E} = \{\textsf{ReadWorkspace}, \textsf{WriteOwnOutput}, \textsf{ReadRepo},
\textsf{WriteRepo}, \textsf{Shell}, \textsf{NetFetch}, \textsf{WebSearch},
\textsf{Git}, \textsf{Mcp}\langle s\rangle, \dots\}
$$
Effects form a lattice $(\powerset(\mathcal{E}), \subseteq)$ under union. A leaf's
inferred effect is a set $E \subseteq \mathcal{E}$.

A **capability** is what Pi can grant: a built-in tool, an extension (a *bundle* of
tools — pi-web-utils alone provides four), or a skill. Let $\mathcal{C}$ be the set
of available capabilities, and for each $c \in \mathcal{C}$ let
$\mathrm{tools}(c)$ be the tools it provides and $\mathrm{aff}(c) \subseteq
\mathcal{E}$ the effects it *affords*.

The connection is a fixed, deterministic **affordance map**
$\alpha : \mathcal{E} \to \powerset(\text{tools})$: which tools an effect requires
(e.g. $\textsf{NetFetch} \mapsto \{\code{fetch\_webpage}\}$,
$\textsf{ReadWorkspace} \mapsto \{\code{read}, \code{ls}\}$).

### 1.3 Least privilege as the optimization principle

The harness should grant **no more than the inferred effect needs** — the
**Principle of Least Privilege** (Saltzer & Schroeder 1975), realized concretely in
the **object-capability model** (Dennis & Van Horn 1966; Miller 2006): authority is
a held capability, not an ambient right. Pi's `--tools` allowlist is an
object-capability mechanism — we verified it is *enforced*, not advisory (a leaf
given `read,ls` physically cannot write). So least privilege here is not a
recommendation; it is a runtime guarantee.

Formally, given the required tool set $T = \bigcup_{e \in E}\alpha(e)$, the harness
is the pair:
1. **tool allowlist** $= T$ (the exact least set — the allowlist is per-tool, so
   this is trivially minimal);
2. **extension/skill set** $X \subseteq \mathcal{C}$ that *covers* the non-built-in
   tools of $T$: $\quad T \setminus \mathrm{builtin} \subseteq \bigcup_{c\in X}\mathrm{tools}(c).$

### 1.4 Minimal cover = set cover

Choosing $X$ minimal is the **minimum set-cover problem** (Karp 1972, NP-complete in
general; Chvátal 1979 gives the $\ln n$ greedy). We minimize the **capability
surface**, not just count: each loaded extension injects its whole tool-description
block into the agent's context, so a smaller cover means fewer tokens and less
chance of tool confusion. In practice $|\mathcal{C}|$ is tiny (a handful of
installed extensions), so we solve it **exactly** by brute force; greedy is the
fallback if the registry ever grows.

$$
X^\star = \arg\min_{X \subseteq \mathcal{C}} |X| \quad\text{s.t.}\quad
(T \setminus \mathrm{builtin}) \subseteq \textstyle\bigcup_{c \in X}\mathrm{tools}(c).
$$

The two-level structure is deliberate defence in depth: **extensions provide
availability; the tool allowlist clamps to the exact least set.** Even if a chosen
extension bundles four tools, `--tools` exposes only the ones in $T$.

---

## 2. Where each effect comes from: judge + declare, all local

Everything that determines a leaf's harness is **local to the leaf** (§1.0). There
are two sources, neither of which is the FSM topology:

| Category | What | Source | Why |
|---|---|---|---|
| **role-default** | base effects: $\textsf{ReadWorkspace}$, $\textsf{WriteOwnOutput}$ | the leaf is an `agent` (fixed) | every agent reads its mounted inputs and writes `c.out()` — a property of the *role*, not the graph; a constant, not an inference |
| **judge** | external effects: $\textsf{NetFetch}, \textsf{WebSearch}, \textsf{Shell}, \textsf{Git}, \textsf{Mcp}\langle s\rangle$ | the leaf's `<contract>`, by the design agent | **undecidable to read off prose** — see §3 |
| **declare** | economic harness: model, thinking budget | human / PRD on the node | a cost/quality choice with no internal source |

So: **start from the role-default, judge the external effects the contract implies,
declare the economic irreducibles — then verify statically.** The base set
$\{\textsf{ReadWorkspace}, \textsf{WriteOwnOutput}\}$ is a *constant of the agent
role* (not derived from topology — an earlier draft wrongly attributed it to
`visibleProducers`; that map decides *mounting*, not *capability*, §1.0). The design
agent only ever adds *external* effects, and only when the contract calls for them.

**Relation to the project law.** The pre-existing law *derive the internal, declare
the external* is about **inter-stage data flow** — an inherently global, topological
property. Harness is **not** on that axis: it is local. So harness does not "extend
the law with a third column"; it lives elsewhere — a per-leaf *judge + declare*, with
`derive` absent precisely because there is no graph dependence to derive from.
(`<inputs>` = pure declare, global interface; data flow = pure derive, global;
harness = judge+declare, **local**.)

---

## 3. Why external-effect inference is judgement, not derivation

The base effects are a role constant (§2). The external effects cannot be read off
mechanically:

> The contract is **natural-language prose**. Deciding "does this contract require
> network access?" is deciding a semantic property of an unrestricted
> specification — by **Rice's theorem** this is undecidable in general.

This is the *same* boundary that governs amortization condition (b): the
semantic-property-of-a-spec wall. Therefore external-effect inference is, by
construction, a **judgement** assigned to the design agent (Principle: *decisions
belong to states or agents, never glue*). The agent's judgement is **bounded**: it
chooses from the fixed effect alphabet $\mathcal{E}$, not free text — so the output
is a checkable, finite annotation, not arbitrary configuration. This is exactly how
amortization works (the agent judges (b) over a fixed rubric), kept cheap and inline
in the `design` pass.

Concretely, the design agent annotates each agent leaf with an **effect set**
$E \supseteq \{\textsf{ReadWorkspace}, \textsf{WriteOwnOutput}\}$ drawn from
$\mathcal{E}$. Everything after that is deterministic (§5).

---

## 4. Soundness, and the boundary we cannot cross statically

Define two correctness properties of a synthesized harness $H$ with afforded
effects $\mathrm{aff}(H)$ and the agent's *true* runtime effects $E^{\mathrm{run}}$:

- **Safety / least-privilege (provable).** $\mathrm{aff}(H) \subseteq E$ where $E$
  is the inferred effect: the harness grants nothing beyond the inferred need. This
  is *enforced by construction* — $X^\star$ covers exactly $T=\alpha(E)$ and
  `--tools`$=T$. Combined with Pi's enforced allowlist, the leaf **cannot** exceed
  its inferred authority. (This is the security guarantee Compiled AI built by hand;
  here it is a compiler invariant, per leaf.)

- **Sufficiency / progress (NOT provable statically).**
  $E^{\mathrm{run}} \subseteq \mathrm{aff}(H)$: the harness affords everything the
  agent *actually tries* to do at run time. This **cannot** be proven, because
  $E^{\mathrm{run}}$ depends on what the LLM decides to do, which is not available
  before the run. A leaf denied a tool it turns out to need fails at run time.

This asymmetry is fundamental and worth stating plainly:

> Harness synthesis is **sound for safety, incomplete for sufficiency.** We can
> guarantee the harness is *not too permissive*; we cannot statically guarantee it
> is *permissive enough*.

Sufficiency is therefore a **runtime property**, observable only from logs — i.e.
exactly the province of the `evolve` loop (measure→diagnose→refine), via the
external compile→run→evolve cycle. A leaf that fails for want of a capability is a
measure-signal; *widening its inferred effect set* is the refine action. This places
harness sufficiency precisely where the architecture already puts behavioural
correctness, and keeps the compiler statically sound (it never under-grants on
purpose; it only ever errs toward the conservative inference, which evolve widens).

What static checks **can** guarantee (correct-by-construction, lint-level):
- **resolution**: every effect's required tools are afforded by *some* available
  capability (else the contract asks for an effect no installed capability provides
  — a real compile error, like `configFlowErrors`);
- **validity**: every tool name in $T$ is a known built-in or extension tool;
- **minimality**: $X$ is a minimum cover of $T$ (a property of the lowering, not a
  risk);
- **monotonicity**: $\mathrm{aff}(H) \subseteq \alpha(E)$ holds (no privilege leak
  in lowering).

---

## 5. The synthesis algorithm (deterministic, post-judgement)

Given a leaf $n$ with inferred effect set $E$ (base role-constant + external judged):

```
1. T  ← ⋃_{e∈E} α(e)                      # effects → required tools (affordance map)
2. Tx ← T \ builtin                       # non-built-in tools needing an extension
3. X* ← min { X ⊆ C : Tx ⊆ ⋃_{c∈X} tools(c) }   # minimum set cover (exact; greedy fallback)
4. resolve X* → extension paths, skill paths     # capability registry
5. emit harness:
     --tools  join(T)                     # least-privilege allowlist (exact)
     --extension p   for p in paths(X*)
     --skill s       for s in skills(X*)
     (--model, --thinking from `declare`)
     (--no-context-files unless contract needs project context)
6. STATIC CHECKS (§4): resolution, validity, minimality, monotonicity → lint
```

Steps 1–6 are pure functions of $E$ and the capability registry. The only
judgement is producing $E$ (§3), made once by `design`, inline, bounded by the fixed
alphabet $\mathcal{E}$ — **no extra pass, no extra tokens**, exactly like the
amortization rule.

### The affordance map $\alpha$ and registry

$\alpha$ (effect → tools) and the registry (capability → tools, paths, afforded
effects) are small fixed tables, the analogue of a standard library's effect
signatures. Initial seed:

| Effect | tools $\alpha(e)$ | capability |
|---|---|---|
| ReadWorkspace | `read`, `ls`, `grep`, `find` | built-in |
| WriteOwnOutput | `write`, `edit` | built-in |
| Shell | `bash` | built-in |
| NetFetch | `fetch_webpage` | ext: pi-web-utils |
| WebSearch | `web_search` | ext: pi-web-utils |
| Git | `clone_github_repo`, `search_local_repo` | ext: pi-web-utils |
| Mcp⟨s⟩ | (tools of MCP server *s*) | ext wrapping MCP *s* |

Unknown effect / unresolvable capability ⇒ compile error (resolution check).

---

## 6. Effect inference for code states (free, exact — still local)

A pleasant corollary, and still **per-node local** (the effect of a code state is
read from *its own* source, not from its neighbours): for **code** states the effect
set is *exactly computable* with no judgement at all — code is structured, so we read
its effects off the source the way `extractCodeDataIO` already reads its `ctx.data`
I/O. A static scan of the
generated lib (`fs` reads/writes, `child_process`, network calls) yields the exact
effect set. This means:
- code states get a **provably exact** effect set (both safety *and* sufficiency,
  because the source is available — no Rice wall: we are analyzing code, not prose);
- this is the natural home of the deferred **Code Gate** (the CWE-ish safety scan):
  it is just *effect inference over code* + a policy on which effects are forbidden
  (e.g. `eval`, non-literal `child_process`). The safety scan we shelved becomes a
  special case of harness synthesis on the code side.

So harness synthesis unifies: **agents → judged effects (Rice boundary, evolve for
sufficiency); code → derived effects (exact, and the Code Gate falls out).**

---

## 7. Summary — the theory in one paragraph

Automatic harness construction is **local (per-leaf) type-and-effect inference** —
a leaf's harness depends only on its own contract, never on the FSM shape, so there
is no inter-procedural effect propagation. Infer each leaf's latent effect (base
workspace effects are a **role constant**; external effects are **judged** from the
contract by the design agent, bounded by a fixed effect alphabet because Rice
forbids reading them off prose), map effects to required tools via a fixed
affordance map, and realize the **least-privilege capability cover** (a minimum set
cover, exact for small registries) — lowered to Pi's enforced
`--tools`/`--extension`/`--skill` flags. The synthesis is **sound for safety** (the
leaf cannot exceed its inferred authority — a per-leaf object-capability guarantee)
but **incomplete for sufficiency** (it cannot prove the harness is permissive
*enough*; that is a runtime property owned by `evolve`). Code states get the same
treatment with effects computed exactly from source, which also subsumes the Code
Gate. Harness is **not** on the project's *derive-internal / declare-external* axis
(that axis is about global data flow); it is a **local judge + declare** — distinct
from, and orthogonal to, both `<inputs>` (global declare) and data flow (global
derive). Topology touches a leaf only through *mounting* (`visibleProducers`),
which is orthogonal to *capability*.

---

## 8. References

- J. M. Lucassen, D. K. Gifford. *Polymorphic Effect Systems.* POPL 1988.
  (and Gifford & Lucassen, *Integrating Functional and Imperative Programming*, LFP 1986)
- J.-P. Talpin, P. Jouvelot. *Polymorphic Type, Region and Effect Inference.*
  J. Functional Programming, 2(3), 1992.
- F. Nielson, H. R. Nielson, C. Hankin. *Principles of Program Analysis*, Ch. 5
  (Type and Effect Systems). Springer, 1999.
- J. H. Saltzer, M. D. Schroeder. *The Protection of Information in Computer
  Systems.* Proc. IEEE 63(9), 1975. (Principle of Least Privilege)
- J. B. Dennis, E. C. Van Horn. *Programming Semantics for Multiprogrammed
  Computations.* CACM 9(3), 1966. (capabilities)
- M. S. Miller. *Robust Composition: Towards a Unified Approach to Access Control
  and Concurrency Control.* PhD thesis, 2006. (object-capability model)
- R. M. Karp. *Reducibility Among Combinatorial Problems.* 1972. (set cover NP-complete)
- V. Chvátal. *A Greedy Heuristic for the Set-Covering Problem.* Math. of OR 4(3), 1979.
- H. G. Rice. *Classes of Recursively Enumerable Sets and Their Decision Problems.* 1953.
- J. McCarthy, P. J. Hayes. *Some Philosophical Problems from the Standpoint of
  Artificial Intelligence.* 1969. (the frame problem — what an agent does *not* affect)
