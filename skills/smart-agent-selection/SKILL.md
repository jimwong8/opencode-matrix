---
name: smart-agent-selection
description: Dynamically discovers and intelligently selects the best agents for every task using context-aware analysis and scoring algorithms. Use when there are multiple available agents to choose from, or when you need to route work to the most appropriate specialist agent.
---

# 🧠 Smart Agent Selection System

**Dynamically discovers and intelligently selects the best agents for every task using context-aware analysis and scoring algorithms.**

## 🎯 What Makes It "Smart"?

### 1. **Dynamic Agent Discovery**

Instead of hardcoding agent lists, the system automatically discovers ALL available agents from:

- ✅ **Global built-in agents** (general-purpose, Explore, Plan)
- ✅ **Installed plugin agents** (backend-architect, frontend-developer, tdd-orchestrator, etc.)
- ✅ **Project-specific custom agents** (`.claude/agents/`)
- ✅ **Plugin marketplace agents** (auto-detected from installed_plugins.json)

**How it works:**
```bash
~/.claude/hooks/discover-agents.sh
# Scans:
# 1. ~/.claude/plugins/installed_plugins.json
# 2. Each plugin's agent directory
# 3. .claude/agents/ in current project
# 4. Built-in agent registry
#
# Returns JSON:
# [
#   {
#     "name": "ccpm:backend-architect",
#     "type": "plugin",
#     "description": "Expert backend architect...",
#     "path": "~/.claude/plugins/..."
#   },
#   ...
# ]
```

### 2. **Context-Aware Analysis**

The smart selector analyzes MULTIPLE context sources:

- **User Message** - What did user ask for?
- **Tech Stack** - What technologies are in this project? (from package.json, etc.)
- **Recent Files** - What files were recently modified?
- **Git Branch** - What branch are we on?
- **Conversation History** - What's been discussed?
- **Working Directory** - What project are we in?

**Example:**
```javascript
User: "Add user authentication"
Context Detected:
- Tech Stack: ["nodejs", "express", "typescript"]
- Recent Files: ["src/routes/users.ts"]
- Project: API backend
- Task Type: Implementation + Security

→ Selects: backend-architect + security-auditor + tdd-orchestrator
```

### 3. **Intelligent Scoring Algorithm**

Each agent gets a relevance score (0-100+) based on:

```javascript
Score Calculation:
+ 10 points: Each keyword match (user request vs agent description)
+ 20 points: Task type match (implementation, debugging, review, etc.)
+ 15 points: Tech stack match (React agent for React project)
+ 5 points:  Plugin agents (more specialized than global)
+ 25 points: Project-specific agents (HIGHEST - custom for this codebase)

Example Scores:
- ccpm:backend-architect: 95 (perfect match)
- ccpm:frontend-developer: 30 (wrong domain)
- custom-api-validator (project): 110 (project-specific bonus!)
```

Top 1-3 highest-scoring agents are selected.

### 4. **Execution Planning**

The system doesn't just select agents - it plans HOW to use them:

**Sequential Execution** (Step-by-step):
```
1. backend-architect → Design API
2. tdd-orchestrator → Write tests
3. Implementation
4. security-auditor + code-reviewer → Validate (parallel)
```

**Parallel Execution** (Simultaneous):
```
frontend-developer + backend-architect (independent work)
```

### 5. **Smart Decision Making**

The selector makes intelligent choices:

**Skip agents for:**
- Simple questions ("How do I use React Query?") → Use Context7 MCP instead
- Documentation tasks → No code agents needed
- Trivial changes → Don't over-invoke

**Invoke agents for:**
- Implementation → TDD first, then implement, then review
- Security-critical → Always security-auditor
- Complex tasks → Multiple specialized agents

## 📊 Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ User: "Add JWT authentication to API"                           │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Hook Trigger: UserPromptSubmit                                   │
│ Executes: smart-agent-selector.prompt                            │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 1: Dynamic Agent Discovery (discover-agents.sh)             │
│                                                                   │
│ Scans:                                                            │
│ ├─ Plugin agents: ccpm:*, code-review-ai:*                       │
│ ├─ Global agents: general-purpose, Explore, Plan                 │
│ └─ Project agents: .claude/agents/*                              │
│                                                                   │
│ Found: 28 agents                                                  │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 2: Context Collection                                       │
│                                                                   │
│ Detected:                                                         │
│ ├─ Tech Stack: nodejs, express, jwt, typescript                  │
│ ├─ Task Type: implementation + security                          │
│ ├─ Recent Files: src/auth/*.ts                                   │
│ ├─ Keywords: "JWT", "authentication", "API"                      │
│ └─ Project: backend-api-service                                  │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 3: Agent Scoring & Ranking                                  │
│                                                                   │
│ Scored Agents:                                                    │
│ 1. ccpm:backend-architect       Score: 95         │
│    + Keyword: "API" (10), "authentication" (10)                  │
│    + Task type: backend implementation (20)                       │
│    + Tech: nodejs, express (30)                                   │
│    + Plugin: (5)                                                  │
│                                                                   │
│ 2. ccpm:security-auditor   Score: 90         │
│    + Keyword: "authentication" (10), "security" (10)              │
│    + Task type: security-critical (20)                            │
│    + Tech: jwt (15)                                               │
│    + Plugin: (5)                                                  │
│                                                                   │
│ 3. ccpm:tdd-orchestrator        Score: 85         │
│    + Task type: implementation (20)                               │
│    + Tech: nodejs (15)                                            │
│    + Always for implementation (bonus)                            │
│                                                                   │
│ [... 25 other agents scored lower ...]                           │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 4: Execution Planning                                       │
│                                                                   │
│ Execution: Sequential                                             │
│                                                                   │
│ Plan:                                                             │
│ Step 1: [backend-architect]                                      │
│   → Design: API endpoints, JWT strategy, token flow              │
│                                                                   │
│ Step 2: [tdd-orchestrator]                                       │
│   → Write tests: signup, login, verify, refresh token            │
│                                                                   │
│ Step 3: Implementation                                            │
│   → Code JWT auth logic                                           │
│                                                                   │
│ Step 4: [security-auditor] + [code-reviewer] (parallel)          │
│   → Validate security + code quality                              │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 5: Inject Instructions into Claude's Context                │
│                                                                   │
│ Injected:                                                         │
│ "INVOKE ccpm:backend-architect to design JWT auth  │
│  system. Then INVOKE tdd-orchestrator to write tests. Then       │
│  implement. Finally INVOKE security-auditor + code-reviewer."    │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Claude Receives Enhanced Context                                 │
│                                                                   │
│ Now Claude knows:                                                 │
│ ✅ Which agents to invoke                                        │
│ ✅ In what order                                                 │
│ ✅ Why these agents                                              │
│ ✅ What each should do                                           │
│                                                                   │
│ → Claude automatically invokes agents following the plan         │
└──────────────────────────────────────────────────────────────────┘
```

## 🚀 Benefits Over Static Agent Lists

### Old Way (Hardcoded):
```json
{
  "agents": [
    "backend-architect",
    "frontend-developer",
    "tdd-orchestrator",
    "code-reviewer"
  ]
}
```

**Problems:**
- ❌ Doesn't know about new plugins you install
- ❌ Can't use project-specific custom agents
- ❌ No scoring - picks first match
- ❌ No context awareness
- ❌ Same agents for all tasks

### New Way (Smart Discovery):

**Advantages:**
- ✅ **Auto-discovers** new plugins when installed
- ✅ **Prioritizes** project-specific agents (custom for your codebase)
- ✅ **Scores** agents by relevance (0-100+ scale)
- ✅ **Context-aware** (tech stack, recent files, task type)
- ✅ **Dynamic** selection per task
- ✅ **Execution planning** (parallel vs sequential)
- ✅ **Explainable** (shows why each agent was selected)

## 📈 Real-World Examples

### Example 1: Backend + Security Task

**User:** "Implement password reset API"

**Smart Selection Process:**
```javascript
1. Discover: 28 agents found
2. Context:
   - Tech: nodejs, express, nodemailer
   - Files: src/api/auth.ts
   - Type: backend implementation + security
3. Scoring:
   - backend-architect: 95 (perfect match)
   - security-auditor: 90 (password = security)
   - tdd-orchestrator: 85 (implementation)
   - email-service-agent: 80 (if exists in project)
4. Plan:
   Step 1: Design password reset flow
   Step 2: Write tests for reset logic
   Step 3: Implement
   Step 4: Security audit (OWASP, email security)
5. Result: 4 agents, sequential execution
```

### Example 2: Frontend Bug Fix

**User:** "Fix the navigation menu not closing on mobile"

**Smart Selection:**
```javascript
1. Discover: 28 agents
2. Context:
   - Tech: react, react-native, typescript
   - Files: src/components/Navigation.tsx
   - Type: bug fix (mobile)
3. Scoring:
   - debugger: 100 (bug fix keyword)
   - mobile-developer: 75 (mobile-specific)
   - frontend-developer: 65 (react)
4. Plan:
   Step 1: Debug mobile navigation issue
   Step 2: Fix
   Step 3: Test on mobile
5. Result: 1 agent (debugger), quick fix
```

### Example 3: Project-Specific Agent Priority

**User:** "Validate the new GraphQL schema"

**Smart Selection:**
```javascript
1. Discover: 30 agents (including custom-schema-validator in project)
2. Context:
   - Tech: graphql, apollo, typescript
   - Files: schema.graphql
   - Type: validation
3. Scoring:
   - custom-schema-validator (project): 110 (+25 project bonus!)
   - graphql-architect (plugin): 85
4. Plan:
   Step 1: Run custom-schema-validator (knows your specific rules)
5. Result: Project-specific agent prioritized
```

## 🛠️ How to Use

### 1. Installation (Already Done!)

Files created:
```
~/.claude/hooks/
├── discover-agents.sh              # Scans for all agents
├── smart-agent-selector.prompt     # Scoring & selection logic
└── run-smart-agent-selector.sh     # Wrapper script
```

### 2. Configuration

Merge into `~/.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "promptFile": "~/.claude/hooks/smart-agent-selector.prompt",
            "timeout": 20000
          }
        ]
      }
    ]
  }
}
```

### 3. Create Project-Specific Agents (Optional)

Want the system to prioritize YOUR custom agents?

```bash
mkdir -p .claude/agents
```

Create `.claude/agents/api-validator.md`:
```markdown
---
description: Validates API endpoints against our company standards
---

# API Validator

Custom validation for:
- Our REST API naming conventions
- Required headers (X-Request-ID, etc.)
- Rate limiting rules
- Error response format
...
```

**Result:** Smart selector will give this agent **+25 points** (highest priority!)

### 4. Test It

```bash
# Try a request
"Add user authentication"

# Check if smart selector runs
# Should see agent discovery + selection in verbose mode
```

## 📊 Advanced Features

### Custom Scoring Weights

Edit `smart-agent-selector.prompt` to adjust weights:

```javascript
// Current weights:
+ 10: Keyword match
+ 20: Task type match
+ 15: Tech stack match
+ 5:  Plugin vs global
+ 25: Project-specific

// Want to prioritize plugins more?
+ 15: Plugin vs global  // Changed from 5

// Want to prioritize tech stack less?
+ 5:  Tech stack match  // Changed from 15
```

### Filter Agents by Capability

Add filtering logic to only consider agents with specific capabilities:

```javascript
// In smart-agent-selector.prompt, add:
const filteredAgents = availableAgents.filter(agent => {
  // Only agents that can handle TypeScript
  if (techStack.includes('typescript')) {
    return agent.description.includes('typescript') ||
           agent.description.includes('ts');
  }
  return true;
});
```

### Agent Caching

To improve performance, cache agent discovery:

```bash
# In discover-agents.sh, add caching:
CACHE_FILE="/tmp/claude-agents-cache.json"
CACHE_AGE=300  # 5 minutes

if [ -f "$CACHE_FILE" ]; then
  AGE=$(($(date +%s) - $(stat -f %m "$CACHE_FILE")))
  if [ $AGE -lt $CACHE_AGE ]; then
    cat "$CACHE_FILE"
    exit 0
  fi
fi

# ... discovery logic ...

echo "$agents" | tee "$CACHE_FILE"
```

## 🐛 Troubleshooting

### Agents Not Discovered

```bash
# Test discovery script
~/.claude/hooks/discover-agents.sh | jq .

# Should output JSON array of agents
# If empty, check plugin paths in installed_plugins.json
```

### Wrong Agents Selected

```bash
# Enable verbose logging
claude --verbose

# Check scoring output
# Adjust weights in smart-agent-selector.prompt
```

### Performance Issues

```bash
# Discovery taking too long?
# Add caching (see Advanced Features)

# Timeout errors?
# Increase timeout in settings.json:
"timeout": 30000  # 30 seconds
```

## 📚 Comparison with Other Systems

| Feature | Static List | Smart Discovery |
|---------|-------------|-----------------|
| Auto-detect new plugins | ❌ No | ✅ Yes |
| Project-specific agents | ❌ No | ✅ Yes (+25 score) |
| Context-aware | ❌ No | ✅ Yes (tech stack, files) |
| Scoring algorithm | ❌ No | ✅ Yes (0-100+) |
| Execution planning | ❌ No | ✅ Yes (parallel/sequential) |
| Explainable | ❌ No | ✅ Yes (shows reasoning) |
| Performance | ⚡ Fast | 🐢 ~2-5 sec overhead |

## 🎯 Summary

The Smart Agent Selection System provides:

1. **Dynamic Discovery** - Finds all agents automatically
2. **Intelligent Scoring** - Ranks agents by relevance (0-100+)
3. **Context-Aware** - Uses tech stack, recent files, task type
4. **Execution Planning** - Sequential or parallel
5. **Project Priority** - Custom agents score highest
6. **Explainable** - Shows why agents were selected

**Result:** The right agents, automatically selected, every time.

---

**Next Steps:**
1. ✅ Test with `"Add user authentication"` request
2. ✅ Create project-specific agents in `.claude/agents/`
3. ✅ Adjust scoring weights if needed
4. ✅ Monitor agent selection in verbose mode

**Questions?** Check `/Users/duongdev/.claude/hooks/README.md`
