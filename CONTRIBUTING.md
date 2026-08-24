# Contributing

Keep the reasoning engine and setup logic platform-neutral. Windows and Linux wrappers should only resolve operating-system paths and delegate to the shared scripts in `scripts/`.

Run before submitting changes:

```bash
npm run check
```

Run the live graph test against a local Neo4j instance when changing graph behavior:

```bash
npm run test:integration
```

Do not add Git-branch/worktree behavior, arbitrary Cypher access, remote transport, authentication infrastructure, an embedded LLM, or runtime npm dependencies without an explicit architectural decision.
