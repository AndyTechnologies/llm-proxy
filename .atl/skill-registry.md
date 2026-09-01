# Skill Registry

Scope: user-level skills. Built by sdd-init for `/home/andy/Proyectos/llm-proxy`.
Note: `sdd-*`, `_shared`, and `skill-registry` are skipped per skill-registry scan rules.
Deduped by skill name (canonical source: `~/.config/opencode/skills`; `~/.agents/skills` mirrors it; `~/.claude/skills` adds `hf-cli`).

## User Skills

| Skill | Trigger (description) | Path |
| ----- | --------------------- | ---- |
| branch-pr | Create Gentle AI pull requests with issue-first checks. Trigger: creating/opening/preparing PRs for review. | /home/andy/.config/opencode/skills/branch-pr/SKILL.md |
| chained-pr | PRs over 400 lines, stacked PRs, review slices. Split oversized changes into chained PRs. | /home/andy/.config/opencode/skills/chained-pr/SKILL.md |
| cognitive-doc-design | Design docs that reduce cognitive load. Trigger: guides, READMEs, RFCs, onboarding, architecture, review-facing docs. | /home/andy/.config/opencode/skills/cognitive-doc-design/SKILL.md |
| comment-writer | Write warm, direct collaboration comments. Trigger: PR feedback, issue replies, reviews, Slack, GitHub comments. | /home/andy/.config/opencode/skills/comment-writer/SKILL.md |
| customize-opencode | Editing/creating opencode's own configuration (opencode.json, .opencode/, ~/.config/opencode/) or opencode agents/subagents/skills/plugins/MCP/permissions. | built-in |
| gentle-ai-bench | Trigger: bench, journey(s), driven mode, gentle-ai-bench, journey corpus. Author/verify bench journeys. | /home/andy/.config/opencode/skills/gentle-ai-bench/SKILL.md |
| go-testing | Trigger: Go tests, go test coverage, Bubbletea teatest, golden files. Apply focused Go testing patterns. | /home/andy/.config/opencode/skills/go-testing/SKILL.md |
| hf-cli | Hugging Face Hub CLI (hf). Trigger: hf, huggingface, AI/ML, cloud storage/checkpoints/datasets/traces. | /home/andy/.agents/skills/hf-cli/SKILL.md |
| issue-creation | Trigger: issue creation, bug reports, feature requests, issue approval. Create/triage GitHub issues from repo evidence. | /home/andy/.config/opencode/skills/issue-creation/SKILL.md |
| judgment-day | Trigger: judgment day, dual review, adversarial review, juzgar. Blind dual review with at most two fix rounds. | /home/andy/.config/opencode/skills/judgment-day/SKILL.md |
| rdd-defect-workflow | Trigger: RDD, receipt-driven development, review authority, delivery gate/kill switch, bounded review defects. | /home/andy/.config/opencode/skills/rdd-defect-workflow/SKILL.md |
| skill-creator | Trigger: new skills, agent instructions, AI usage patterns. Create LLM-first skills with valid frontmatter. | /home/andy/.config/opencode/skills/skill-creator/SKILL.md |
| skill-improver | Trigger: improve/audit/refactor skills, skill quality. Audit/upgrade LLM-first skills. | /home/andy/.config/opencode/skills/skill-improver/SKILL.md |
| systemic-issue-triage | Trigger: new issue, bug report, triage, backlog, issue flood, root cause. Attack issues by root class; fixes must shrink the system. | /home/andy/.config/opencode/skills/systemic-issue-triage/SKILL.md |
| work-unit-commits | Plan commits as reviewable work units. Trigger: implementation, commit splitting, chained PRs, keeping tests/docs with code. | /home/andy/.config/opencode/skills/work-unit-commits/SKILL.md |

## Conventions

No project-level `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `GEMINI.md`, or `copilot-instructions.md` found in `/home/andy/Proyectos/llm-proxy`.

## Notes

- No `~/.config/kilo/skills`, `~/.claude/skills` (except `hf-cli`), `~/.gemini/*`, `~/.cursor/skills`, `~/.copilot/skills`, `~/.codex/skills`, `~/.codeium/windsurf/skills`, `~/.qwen/skills`, `~/.kiro/skills`, or `~/.openclaw/skills` beyond those listed — all other candidate user skill dirs are absent on this machine.
