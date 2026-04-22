---
name: log
description: Log history entry with AI enhancement and multimodal support
---

# AI-Enhanced Intelligent Logging

Quickly log work with AI-powered enhancement, intelligent routing, and automatic goal linking. Claude analyzes your input and automatically decides whether to create history entries (accomplishments) or context notes (information), and whether to split multi-part work into separate logs. Supports multimodal input including images and screenshots.

## Usage

```
/aissist:log <text>
```

Or with images:

```
/aissist:log [attach image(s)] <text>
```

**For retroactive logging** (when you want to log something that happened on a past date):

Simply mention the date naturally in your text - Claude will detect it automatically:
```
/aissist:log Yesterday I fixed the critical auth bug
/aissist:log Last Friday we completed the sprint planning session
/aissist:log On Monday I deployed the new feature to production
/aissist:log Two days ago I had an emergency production fix
```

If no date is mentioned, the log defaults to today.

## Arguments

- `text` (required): Freeform description of what you worked on or accomplished. Can be rough notes - Claude will enhance and structure it. If you mention when the work was done (e.g., "yesterday", "last Friday"), Claude automatically detects it and logs with that date. Otherwise, defaults to today.

## Examples

### Simple Text Logging

```
/aissist:log Fixed auth bug, took 3 hours
```

Claude enhances → `"Resolved authentication bug in login flow (3 hours)"`

```
/aissist:log Refactored database layer, added repository pattern, updated tests
```

Claude structures → `"Refactored database layer: implemented repository pattern for common queries and updated test coverage"`

### Multi-line Detailed Description

```
/aissist:log Today I worked on improving the API performance.
I optimized the database queries and added caching.
Response time went from 500ms to 120ms.
```

Claude condenses → `"Optimized API performance: improved database queries and implemented caching, reducing response time from 500ms to 120ms"`

### Logging with Images/Screenshots

```
/aissist:log [attach dashboard screenshot] Updated the dashboard design
```

Claude analyzes image → `"Updated dashboard: redesigned metrics cards with improved data visualization, added responsive layout and dark mode support"`

```
/aissist:log [attach performance graph] Performance improvements after optimization
```

Claude extracts metrics → `"Performance optimization: Reduced memory usage by 40% and improved throughput from 1000 to 1500 req/s (based on metrics)"`

### Before/After Comparisons

```
/aissist:log [before.png, after.png] Redesigned the login page
```

Claude compares → `"Redesigned login page: modernized UI with cleaner layout, improved accessibility, and streamlined authentication flow"`

### Retroactive Logging (Automatic Date Detection)

**Just write naturally** - Claude extracts the date automatically:

```
/aissist:log Yesterday I fixed the authentication bug
```
→ Claude detects "yesterday" and calls: `aissist history log "Fixed authentication bug" --date yesterday`

```
/aissist:log Last Friday I completed the API refactoring work
```
→ Claude detects "last Friday" and calls: `aissist history log "Completed API refactoring work" --date "last friday"`

```
/aissist:log On January 15th I deployed the new feature
```
→ Claude detects "January 15th" and calls: `aissist history log "Deployed new feature" --date 2025-01-15`

```
/aissist:log Two days ago I had an emergency production hotfix
```
→ Claude detects "two days ago" and calls: `aissist history log "Emergency production hotfix" --date "2 days ago"`

```
/aissist:log Fixed the payment processing bug
```
→ No date mentioned, defaults to today: `aissist history log "Fixed payment processing bug"`

**How it works**: Claude intelligently detects temporal references in your text (yesterday, last week, specific dates, etc.), extracts them, removes them from the enhanced log text, and automatically adds the `--date` flag to the command. Just write naturally - no need to remember any flags!

**Use case**: When you forget to log your work at the time, or when you're catching up on logging past accomplishments. Simply mention when it happened in your text, and Claude handles the rest.

## What it does

This command leverages Claude's AI capabilities to intelligently route and structure your input:

1. **Accept input**: Receives your text description and any attached images/screenshots

2. **Extract temporal references**: Detects date/time mentions in your text:
   - Natural language: "yesterday", "last week", "two days ago", "last Friday"
   - Specific dates: "January 15th", "on Monday", "2025-01-15"
   - Relative timeframes: "3 days ago", "last month"
   - Removes the temporal reference from the text to avoid duplication
   - Prepares the `--date` flag for the CLI command

3. **Analyze images** (if provided): Uses Claude's vision capabilities to:
   - Describe UI changes and visual improvements
   - Extract metrics from graphs and performance charts
   - Identify key details from screenshots or diagrams
   - Compare before/after images to summarize changes

4. **Enhance text**: Rephrases and structures your input into clear, professional entries:
   - Preserves exact metrics, numbers, and time estimates
   - Removes temporal references (already extracted in step 2)
   - Converts rough notes into polished descriptions
   - Maintains technical accuracy while improving clarity

5. **Analyze content type and structure**: Examines the enhanced content to determine:
   - **Multi-part detection**: Are there multiple distinct accomplishments or tasks?
   - **Content classification**: Is this task-oriented (accomplishment) or informational (notes/context)?
   - **Routing decision**: Should this go to history, context, or both?

6. **Check goals**: Runs `aissist goal list` to see your active goals (for history entries)

7. **Route intelligently** based on content analysis:

   **For task-oriented content (accomplishments):**
   - Split into multiple logs if multiple distinct tasks identified
   - For each task, perform semantic goal matching independently
   - Execute `aissist history log "<enhanced-text>"` with optional `--goal <codename>` and `--date <date>` if specified
   - Maximize granularity while maintaining logical grouping

   **For informational content (notes/context):**
   - Infer appropriate context name from content:
     - Meeting notes → "work" or "meeting"
     - Technical decisions → "technical" or "architecture"
     - Documentation → "project-notes" or "documentation"
     - Requirements/constraints → "requirements" or "technical"
   - Execute `aissist context log <name> "<content>"`

   **For mixed content:**
   - Split task accomplishments and informational notes
   - Route tasks to history (with goal linking)
   - Route notes to context (with name inference)
   - Execute both commands as needed

8. **Confirm with transparency**: Shows you what was created:
   - Number of history entries and which goals they're linked to
   - Number of context entries and their context names
   - Clear summary of all routing decisions made

### AI Enhancement Examples

**Input**: `fixed the authentication bug took me like 3 hours`
**Enhanced**: `"Resolved authentication bug in login flow (3 hours)"`

**Input**: `worked on refactoring the database stuff`
**Enhanced**: `"Refactored database layer: improved code organization and query structure"`

**Input**: `Improved performance from 500ms to 120ms by optimizing queries and adding cache`
**Enhanced**: `"Optimized API performance: improved database queries and implemented caching, reducing response time from 500ms to 120ms"`

**Input**: `Yesterday I fixed the authentication bug took me like 3 hours`
**Date Extracted**: `yesterday`
**Enhanced**: `"Resolved authentication bug in login flow (3 hours)"`
**Command**: `aissist history log "Resolved authentication bug in login flow (3 hours)" --date yesterday`

**Input**: `Last Friday we completed the sprint planning and backlog grooming session`
**Date Extracted**: `last Friday`
**Enhanced**: `"Completed sprint planning and backlog grooming session"`
**Command**: `aissist history log "Completed sprint planning and backlog grooming session" --date "last friday"`

### Goal Linking

If the content matches an existing goal, Claude automatically links it:

```
# You have a goal: "improve-api-performance"
/aissist:log Optimized database queries, API is 50% faster now

# Claude calls:
aissist history log "Optimized database queries: achieved 50% performance improvement" --goal improve-api-performance
```

## Intelligent Routing Examples

### Multi-Log Splitting (Multiple Accomplishments)

**Input**:
```
/aissist:log Today I fixed the authentication bug in the login flow, refactored the database connection pooling, and added comprehensive unit tests for the user service
```

**Claude's Analysis**:
- Identifies 3 distinct accomplishments
- Enhances each separately
- Performs goal matching for each

**Executes**:
```bash
aissist history log "Resolved authentication bug in login flow" --goal improve-auth
aissist history log "Refactored database connection pooling for improved performance"
aissist history log "Added comprehensive unit test coverage for user service" --goal testing-improvements
```

**Feedback**: `Created 3 history entries (2 linked to goals: improve-auth, testing-improvements)`

---

**Input**:
```
/aissist:log Fixed payment bug, updated docs, deployed to staging
```

**Executes**:
```bash
aissist history log "Resolved payment processing bug"
aissist history log "Updated payment system documentation"
aissist history log "Deployed payment changes to staging environment"
```

**Feedback**: `Created 3 history entries`

---

### Single Log (Cohesive Work)

**Input**:
```
/aissist:log Spent 4 hours debugging and fixing the memory leak in the background worker
```

**Claude's Analysis**:
- Identifies single cohesive accomplishment
- Keeps as one entry

**Executes**:
```bash
aissist history log "Resolved memory leak in background worker (4 hours)"
```

**Feedback**: `Created 1 history entry`

---

### Context Routing (Informational Content)

**Input**:
```
/aissist:log Team standup: Sarah is working on the API, John is blocked on deployment credentials, we decided to use JWT for authentication
```

**Claude's Analysis**:
- Identifies as meeting notes (informational, not accomplishment)
- Infers context name: "work" or "meeting"

**Executes**:
```bash
aissist context log work "Team standup notes: Sarah working on API implementation, John blocked on deployment credentials. Decision: Using JWT for authentication across all services"
```

**Feedback**: `Saved to context (work): Team standup notes`

---

**Input**:
```
/aissist:log Important: Stripe API has a 30-second timeout limit. Need to account for this in all payment processing
```

**Claude's Analysis**:
- Identifies as technical constraint (informational)
- Infers context name: "technical"

**Executes**:
```bash
aissist context log technical "Stripe API constraint: 30-second timeout limit must be accounted for in payment processing"
```

**Feedback**: `Saved to context (technical): Stripe API constraint`

---

**Input**:
```
/aissist:log Architecture decision: Moving to microservices for better scalability. Will split monolith into user service, payment service, and notification service
```

**Claude's Analysis**:
- Identifies as architectural decision (informational)
- Infers context name: "architecture"

**Executes**:
```bash
aissist context log architecture "Architecture decision: Transitioning to microservices architecture - splitting monolith into user service, payment service, and notification service for improved scalability"
```

**Feedback**: `Saved to context (architecture): Architecture decision`

---

### Mixed Content (Task + Information)

**Input**:
```
/aissist:log Fixed the payment gateway timeout issue. Note: Stripe API has a 30-second timeout limit that we need to account for in future work
```

**Claude's Analysis**:
- Identifies task accomplishment: fixing the bug
- Identifies informational note: API constraint
- Splits into separate entries

**Executes**:
```bash
aissist history log "Resolved payment gateway timeout issue" --goal fix-payments
aissist context log technical "Stripe API constraint: 30-second timeout limit must be accounted for in payment processing"
```

**Feedback**: `Created 1 history entry (linked to fix-payments) and 1 context entry (technical)`

---

**Input**:
```
/aissist:log Completed the user authentication module. Team decided we'll use OAuth 2.0 with refresh tokens. Also finished writing integration tests
```

**Claude's Analysis**:
- Identifies 2 task accomplishments + 1 decision note
- Routes tasks to history, decision to context

**Executes**:
```bash
aissist history log "Completed user authentication module" --goal build-auth
aissist history log "Finished writing integration tests for authentication" --goal build-auth
aissist context log technical "Authentication decision: Using OAuth 2.0 with refresh token implementation"
```

**Feedback**: `Created 2 history entries (linked to build-auth) and 1 context entry (technical)`

---

### Image with Contextual Information

**Input**:
```
/aissist:log [attach architecture diagram] Current system architecture for reference
```

**Claude's Analysis**:
- Analyzes diagram using vision
- Identifies as reference material (no task completed)
- Routes to context

**Executes**:
```bash
aissist context log architecture "System architecture: Microservices with API gateway, three core services (user, payment, notification), PostgreSQL database, Redis cache, deployed on AWS with load balancing"
```

**Feedback**: `Saved to context (architecture): System architecture diagram`

---

## Decision Criteria

### Task-Oriented (Routes to History)
- Completed work or accomplishments
- Bugs fixed
- Features implemented
- Code refactored
- Tests written
- Deployments executed
- Problems solved
- Milestones reached

### Informational (Routes to Context)
- Meeting notes
- Team discussions
- Technical decisions
- Architecture choices
- API documentation
- Constraints or limitations
- Requirements gathered
- Reference information
- Learnings or insights (without associated task)

### When to Split into Multiple Logs
- Multiple distinct accomplishments mentioned
- Separate, unrelated tasks completed
- Different areas of work (e.g., frontend + backend + testing)
- Each part could independently answer "What did I accomplish?"
- Maximize granularity while maintaining meaning

### When to Keep as Single Log
- Closely related work forming one cohesive unit
- Sub-tasks of a larger accomplishment
- Debugging process leading to one fix
- All work toward one specific outcome

## Requirements

- aissist initialized (run `aissist init` first)
- Active Claude Code session for AI enhancement
- For image logging: Images/screenshots attached to the message

## Tips

- **Be concise or detailed - both work**: You can provide rough notes or detailed descriptions - Claude will handle enhancement and routing
- **Include metrics**: Specific numbers, percentages, or time estimates are preserved exactly
- **Attach images**: Screenshots of UI changes, performance graphs, or error messages provide valuable context
- **Mention dates naturally for retroactive logging**: Just say "yesterday I fixed..." or "last Friday we completed..." - Claude extracts the date automatically
- **Trust the AI**: Claude will intelligently decide whether to:
  - Split into multiple logs or keep as one
  - Route to history (accomplishments) or context (information)
  - Link to relevant goals automatically
  - Extract and apply the correct date from your text
- **Don't overthink it**: Just describe what you worked on or learned - the routing and date handling will be done intelligently

## See Also

- `/aissist:log-github` - Import GitHub activity as history entries
- `/aissist:recall` - Search your history with semantic queries
- `/aissist:report` - Generate accomplishment reports from your history

---

$ARGUMENTS
