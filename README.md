# opencode-matrix

> A 4-model role-specialized panel for OpenCode — assign different LLMs to different agent roles (Architect / Builder / Crafter / Scout) with intelligent auto-rebalancing.

## What it does

- **4 specialized roles**: 🧠 Architect · ⚒️ Builder · 🎨 Crafter · 🔍 Scout
- **Smart model-to-role assignment**: scores models on reasoning / context / toolcall / vision / cost / speed, picks the best fit per role
- **One-command swap**: tell it "replace model X with Y", it auto-rebalances all 4 roles
- **Skill whitelist per role**: each agent gets curated access to relevant skills
- **Brainstorming guard**: orchestrator auto-loads brainstorming skill on vague requests
- **Code review defense**: backend/frontend use `receiving-code-review` skill to validate review feedback before applying
- **Auto-backup on every change**, **rollback in one command**

## Install

```bash
git clone https://github.com/jimwong8/opencode-matrix.git
cd opencode-matrix
bash install.sh
source ~/.bashrc
```

Or download a release tarball:

```bash
curl -L https://github.com/jimwong8/opencode-matrix/releases/latest/download/opencode-matrix-bundle.tar.gz | tar xz
cd matrix-bundle
bash install.sh
```

## First-run

```bash
matrix --list                  # see what models are available
nano ~/.config/opencode/scripts/matrix.json   # adjust to your providers
matrix                         # apply current matrix.json
# restart OpenCode to take effect
```

## Daily usage

```bash
matrix --show                            # current state
matrix --swap atlascloud/owl xstx/claude-opus-4-7-thinking
matrix --add digitflow/gpt-5.5           # add new candidate, 5-pick-4 optimization
matrix --optimize                        # rebalance current 4 models
matrix --score novai/claude-opus-4-7     # detailed model fitness per role
matrix --rollback                        # undo last change
matrix --interactive                     # guided picker
```

In OpenCode session:

```
/matrix --swap deepseek claude-opus-4-7
/matrix --show
```

## How role assignment works

Each model is scored 0-200 on each role using:

| Dimension       | architect | builder | crafter | scout |
|-----------------|----------:|--------:|--------:|------:|
| reasoning       |       4.0 |     2.5 |     1.5 |   0.5 |
| context window  |       2.0 |     3.0 |     1.0 |   1.0 |
| tool calling    |       1.5 |     3.0 |     2.0 |   2.0 |
| vision          |         0 |       0 |     3.0 |     0 |
| cheap/free      |       0.5 |     1.0 |     1.0 |   3.0 |
| fast            |       0.5 |     0.5 |     1.0 |   4.0 |
| family bonus    |       1.0 |     1.0 |     1.0 |   1.0 |

Then enumerates all 4! permutations of the 4 models across 4 roles and picks the highest-scoring assignment.

## Files installed

```
~/.config/opencode/
├── scripts/
│   ├── matrix.json              # single source of truth — edit this
│   ├── apply-matrix.py          # render + score + rebalance + variant expansion
│   └── apply-matrix.sh          # bash wrapper
├── commands/
│   └── matrix.md                # /matrix slash command
├── agents/
│   ├── swarm-orchestrator.md    # 🧠 architect role
│   ├── swarm-reviewer.md        # 🧠 architect role
│   ├── swarm-backend.md         # ⚒️ builder role
│   ├── swarm-frontend.md        # 🎨 crafter role
│   ├── swarm-tester.md          # 🔍 scout role
│   └── skill-writer.md          # ⚒️ builder role
└── oh-my-opencode.json          # auto-generated, DO NOT edit by hand
```

## Requirements

- OpenCode installed (https://opencode.ai/)
- Python 3
- `oh-my-openagent@latest` plugin (recommended, for the "Greek god" agents like sisyphus / atlas)

## How variants work

When a model has variants (e.g., `low/medium/high/max`), the matrix expands variant names to provider-native fields automatically:

- `nemotron-3-super-free` + `variant=high` → frontmatter writes `reasoningEffort: high`
- `claude-opus-4-1` + `variant=high` → frontmatter writes the appropriate `thinking:` block

You can see what gets expanded with `matrix --score <model>`.

## Cross-machine sync

```bash
# On source machine, push the config
cd ~/.config/opencode && git add . && git commit -m "matrix config" && git push

# On new machine
git clone https://github.com/jimwong8/opencode-matrix.git
cd opencode-matrix && bash install.sh
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ matrix.json  (you edit this — 4 model slots)            │
│       │                                                 │
│       ▼ apply-matrix.py                                 │
│       │                                                 │
│       ├──→ oh-my-opencode.json    (Greek god agents)    │
│       ├──→ oh-my-openagent.json   (sync mirror)         │
│       └──→ ~/.config/opencode/agents/swarm-*.md         │
│              frontmatter (model + reasoningEffort)      │
│                                                         │
│ Backups:                                                │
│   *.json.bak-matrix-<timestamp>                         │
└─────────────────────────────────────────────────────────┘
```

## Why two layers?

`oh-my-openagent` plugin only manages built-in agents (sisyphus, atlas, hephaestus, etc.). Custom local agents in `~/.config/opencode/agents/*.md` need their `model:` field written directly into frontmatter. The matrix tool does both in one pass.

## License

MIT

## Contributing

PRs welcome. Especially appreciated:
- New `KNOWN_MODEL_BOOSTS` entries for top-tier models with incomplete metadata
- Better role-fit heuristics
- Translations of the README
