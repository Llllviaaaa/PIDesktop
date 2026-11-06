# @pid/kernel

Microkernel orchestration primitives built on `@deepseek-ai/cordis`:

- Deterministic topological sorting for plugin mount and reverse-order teardown;
- Accurate Cordis fiber state inspection (`active` vs `pending` unmet `inject` dependencies vs `errored`);
- Isolated child context scopes for project-level `.pid/plugins` so workspace plugins never leak across projects.
