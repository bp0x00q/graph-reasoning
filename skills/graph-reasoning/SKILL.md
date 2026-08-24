---
name: graph-reasoning
description: Use the local Neo4j reasoning graph to form, explore, challenge, backtrack, and synthesize materially different reasoning paths during ambiguous or consequential work.
---

# Graph Reasoning

Use this skill when a task has competing plausible causes, materially different interpretations or designs, consequential untested assumptions, repeated failed attempts, or an explicit request for deep branch-and-backtrack reasoning.

Do not use it for trivial, deterministic tasks where one direct path is sufficient.

## Operating contract

Neo4j is the authoritative explicit reasoning state. The conversation is not. Reason through the graph while working; do not finish the analysis first and log a summary afterward.

The graph stores concise, decision-relevant propositions and their dependencies. It is not a verbatim transcript of hidden chain of thought.

Codex forms the branches autonomously from the situation. The MCP server validates and materializes them. The user should not need to name or steer internal branches.

## Required loop

1. Call `reasoning_start` at the beginning, or resume the supplied `run_id`.
2. Call `reasoning_inspect` with `active_context` before making a consequential move after interruption, compaction, backtracking, or branch switching.
3. Use `reasoning_advance` to batch a small coherent set of observations, assumptions, evidence, experiments, inferences, contradictions, or conclusions. Supplying `branch_id` focuses or resumes that branch and its suspended ancestor lineage.
4. Call `reasoning_branch` when two or more materially distinct alternatives could change the answer or next action.
5. Explore branches by seeking distinguishing evidence, not by accumulating support for the first idea.
6. Challenge promising branches. Record contradicting evidence and dependencies explicitly.
7. Call `reasoning_backtrack` when a path is refuted, blocked, or no longer worth pursuing. When returning across nested branch points, the abandoned path extends from the focused leaf through the branch that departed from the selected branch point. Preserve valid observations and evidence; abandon branch-local assumptions and conclusions.
8. Use `reasoning_integrate` when compatible findings from multiple paths jointly explain the situation.
9. Inspect the `audit` view before completion. Resolve high-severity findings or clearly report why the run remains incomplete.
10. Call `reasoning_finish` before producing the final answer.

## Branching discipline

Create a branch point for consequential alternatives such as:

- competing root causes;
- different interpretations of ambiguous evidence;
- architectures with materially different trade-offs;
- an assumption whose truth changes the plan;
- contradictory observations;
- an apparent dead end that warrants returning to an earlier decision.

Do not create branches for cosmetic choices, equivalent commands, or every minor thought. Prefer a few distinct branches with discriminating tests over many paraphrases.

Nested branch points are expected when exploration reveals deeper uncertainty.

The active branch inherits active reasoning nodes from its ancestor branches. Do not duplicate inherited propositions into each child branch.

## Evidence and dependency discipline

- Mark whether each node is global or branch-local.
- Link inferences and conclusions to the nodes they depend on.
- Distinguish observation from assumption.
- Record evidence that refutes a branch as carefully as evidence that supports one.
- Do not promote branch-local claims into global context merely because they are convenient.
- Do not treat self-reported confidence as evidence.

## Tool economy

Batch tightly related reasoning nodes in one `reasoning_advance` call. Do not create graph noise. A useful node should affect a decision, preserve evidence, expose an assumption, or explain a backtrack.

## Failure behavior

If Neo4j or the MCP server is unavailable, fail closed: report that graph reasoning could not proceed. Do not silently simulate the completed graph afterward and claim the protocol was followed.

## Final response

Use the supported final projection to provide the user with the result, strongest evidence, important rejected paths, and material unresolved uncertainty. Do not dump the full graph or a private internal monologue.
