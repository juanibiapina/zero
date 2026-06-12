---
name: plan
description: "Use before starting work on any coding task: implementing a feature, fixing a bug, refactoring, or changing code."
---

# Plan Mode

Read, research, and create an implementation plan.

## Workflow

### 1. Research

Before planning, explore the codebase to understand what exists:

- Load the `vocabulary` skill so the plan uses consistent software-design terms
- Read project documentation (READMEs, docs) for conventions and guidelines
- Explore relevant files, where changes will be made, potentially related files that may need to change
- Check for related patterns, prior art, and existing implementations
- Review recent git history for context
- Understand the architecture and constraints
- Understand the current state of the code involved in this change

### 2. Plan

Choose a detail level based on complexity:

**Minimal**, for simple, well-understood changes:
- Goal
- What to change and why
- Tests to add or update
- Docs to add or update
- Acceptance criteria

**Comprehensive**, for architectural changes, complex features or entire new projects:
- Goal
- What to change and why
- Technical approach with alternatives considered
- System-wide impact (what else is affected, error propagation, state risks)
- Implementation phases
- Test strategy: what kinds of tests, coverage of new paths, edge cases
- Documentation strategy
- Acceptance criteria
- Risks, dependencies, and mitigations

Default to **minimal**.

### 3. Present

Write the detailed plan to a file.

Present the plan to the user with high level steps. The goal is to communicate succintely:
- high level steps so user understand what is changing and why
- architectural changes if any
- public interface changes
- breaking changes

Keep the message brief but complete at a conceptual level so that the user can review without having to look into the plan details or specific code changes.

### 4. Iterate

Iterate over the plan with the user:
- don't assume user is right or plan is right: always double check by looking at the code, documentation or researching online

When the user is satisfied with the plan, start implementing.
