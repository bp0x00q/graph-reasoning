---
name: graph-reasoning-audit
description: Adversarially audit a Neo4j reasoning run for unsupported conclusions, invalid dependencies, premature convergence, and unexplored material alternatives before finalization.
---

# Graph Reasoning Audit

Use this skill before finalizing a nontrivial graph-reasoning run, and whenever the investigation appears to be converging unusually quickly.

## Procedure

1. Call `reasoning_inspect` with `view: "audit"`.
2. Examine every high-severity finding before accepting the current conclusion.
3. Inspect the support path for each consequential conclusion.
4. Check whether any active conclusion depends on a refuted or invalidated node.
5. Check whether a branch was refuted without recorded evidence or a contradiction.
6. Check whether materially distinct alternatives remain unexplored.
7. Check whether branch-local claims leaked into global context.
8. Check whether multiple branches are merely restatements of the same hypothesis.
9. Deliberately seek one plausible disconfirming explanation for the strongest surviving conclusion.
10. Add evidence, branch, backtrack, integrate, or weaken the conclusion as required; then inspect the audit view again.

Open alternatives do not have to be exhausted when their expected value is low. They must remain visible as unresolved uncertainty rather than disappearing from the final account.

Do not manufacture branch count or ceremonial opposition. The goal is to expose consequential weakness, not to make the graph look complicated.
