# Rules

One way to say what should happen when a program reaches something — instead of a control per feature.

Drafted 2026-10-06, before building more of the margin's Mock (LIVE-VALUES.md, "Mocking a value"). Decided the same
day: **one model, extending silo's policy**; **our own model, JSON-compatible with ui-predicate and steered toward JSON
Schema**; the Mock slice (the stub store, F5 using stubs, a run of several cases, Run with Inputs removed, the margin's
Mock) **held on the `rules` branch** until the rule editor replaces its bespoke controls.

## Why

Each feature that decides something about a run grew its own UI:

- a capability stop's *Allow once* / *Allow always* / *Deny* buttons (LIVE-VALUES.md, step 8), and the preview's
  prompt with the same three;
- the Capability calls panel's dispositions (extensions/capabilities);
- Set Value at a stop, then the margin's Mock with *Persist* and *Multiple* for process.argv;
- before that, Run with Inputs' box of `|`-separated runs.

Every one is the same sentence: **when** the program reaches *this* (a call, an input, a line) and it *matches that*,
**then** do *something* (allow it, deny it, stop there, give it this value — once, or always). Each new seam (fetch's
response, a file read, an env variable, a variable's value) would otherwise add another bespoke form to build, style,
test and keep working. The pattern for this is old: macOS's predicate editor (Finder's smart folders, Mail's rules,
Automator), Mailchimp's segments, Zapier's filters — rows of *target / operator / argument*, combined *all* or *any*,
and, for rules, a list of *actions*.

## The model

ui-predicate (github.com/FGRibreau/ui-predicate, MIT) is a clean statement of the predicate half. Its core's model:

- **targets** — what a row is about (`{ target_id, label, type_id }`);
- **types** — which operators a target's type offers (`{ type_id, operator_ids }`);
- **operators** — each with the argument it takes (`{ operator_id, label, argumentType_id }`): "is" on a date and "is"
  on a string are two operators, because their inputs differ;
- **argument types** — the input a row's argument uses (`{ argumentType_id, component }`);
- **logical types** — how rows combine (`{ logicalType_id, label }`: all, any);
- a tree of **comparison predicates** (`{ target_id, operator_id, argument }`) and **compound predicates**
  (`{ logicalType_id, predicates }`).

Rules add the other half — **actions**, each with its argument type too — so a rule is `{ when, then }`:

| feature today | when | then |
|---|---|---|
| a policy rule (`.silo/policy.json`) | capability *is* `fs:write`, resource *matches* `/workspace/**` | allow · deny · ask |
| *Allow always* at a capability stop | capability *is* `fs:write`, resource *is* `/workspace/out.txt` | allow |
| a process.argv stub | program *is* `tax.js`, reads *process.argv* | give: cases `CA SPRING10` · `FR` |
| (slice 2) a mocked call | capability *is* `net`, resource *matches* `https://api.example.com/*` | give: a recorded response |
| a variable mocked at a stop | at the stop, *high* | set: `3` (once) |

The targets, operators, argument types and actions are a **catalog**: adding a seam is adding catalog entries (a
target, its type's operators, an argument type with its input), not a form.

**Once or always** isn't a checkbox per feature: a rule is either applied now (*Just this once*) or saved (*Save as
rule*) — the same two buttons wherever the editor opens.

## Where it lives

- **The model and the evaluation are silo's** (silo-is-the-engine: pure logic and layouts go there): rules extend silo's
  policy (lib: util/silo/policy.ts, 3a04418, da6a88e) — every rule is `{ when, then }`; the first shape, `{ capability,
  resource, disposition }`, is gone (nothing depended on it), and a decision at a call (*Allow always*) is the rule
  *capability is X, resource is Y, then allow*. silo holds the catalog too: `TARGETS` (capability, resource, program,
  process.argv), `TYPES`, `OPERATORS` (each with what it compiles to, and its argument's schema given its target's),
  `ACTIONS`. Saved in the same files: the shared contract
  (`.silo/policy.json`) and mine (`.silo/<you>.policy.json`); a recorded value (a real fetch response) in
  `.silo/local/`, referred to by the rule.
- **One editor**, in the component (rule-editor.ts: vanilla DOM, VS Code-styled — the workbench realm loads no Web
  Awesome and no React but in islands): rows of selects and argument inputs, *all/any/none*, *−* and *+* (⌥: a group),
  and an actions list. It knows no targets: its host passes the catalog, and each argument's input is drawn from its
  schema.
- **Two places it opens**: a **Rules** view listing every rule (rules-view.ts, in the Explorer: mine, then the shared
  contract's, each a sentence in the catalog's words, in the order they're matched; a click opens it in the same panel
  — *Save*, *Remove* for mine, a shared rule's edit saved as mine ahead of it; *New Rule* in its title; collapsed until
  opened, so silo's policy loads then; it and the margin redraw as the policy files change), and
  **inline in the margin**, anchored to a line, prefilled from what's there — a capability stop opens it with the
  call's capability and resource and *allow* chosen; a value's row with its target and *give*. The margin keeps entry
  points (one small control on a row), not forms. First: *Rule…* at a capability stop, beside the three buttons, with
  whether the rule as edited covers the call and what it decides, then *Just this once* / *Save as rule*. Then — the one
  used most — *Mock…* on process.argv's row (LIVE-VALUES.md): *program is <file>*, *then give process.argv* a command
  line per run, *Run* / *Save as rule* / *Remove*; it replaced the stubs file (`.silo/<you>.stubs.json`) and the Mock /
  Persist / Multiple checkboxes. An action names what it acts on (`target_id`: *give process.argv*), and its argument's
  schema follows that target's. Then *Mock…* on a variable's row: *program is <file>*, *at* <this statement>, *then set*
  it — *Just this once* (at this stop) or *Save as rule*.
- **A call's result, given instead of the call** (lib aa47ec8; slice 2): *give result* — a fetch's body, a read's
  contents, a command's output. Only where something stands in for the call: the debugger's capability stand-ins return
  it (and the call isn't a stop); a real call — a preview's — isn't decided by it. At a capability stop, *Rule…* starts
  from what the call returned the last time it ran for real, when that's recorded: the service worker's net gate
  records an allowed preview fetch's JSON or text body (`capability.record.<tab>` → the pod), the latest of each call, in
  `.silo/local/recorded.json` — this machine's only, git-ignored (a real response can hold secrets). *Just this once*
  gives it to this call (`give-once`); *Save as rule* to every run's.
- **The preview's prompt** has *Rule…* too: the rule is made in the Rules view, prefilled with the call
  (`rules.make`, pod → workbench), and the call waits on it — *Just this once*, *Save as rule*, or *Cancel* (back to the
  prompt). *Allow always* stays, the one-click rule.
- **A rule whose place is lost** shows broken in the Rules view; opened, *Re-place at selection* places it at the code
  selected in the editor (a span reference made from the selection, as the margin makes one).
- **A rule placed in the code** (lib 20f01cb): *at* is a target whose argument is a span reference (SPAN-ANNOTATIONS.md),
  shown as a chip of its code, not typed. Before a run the adapter finds each rule's place in the text that runs
  (`editor.annotations.resolve` — through edits, as an authored annotation is) and hands the worker the lines; the worker
  arms them as breakpoints that aren't stops: the statement runs, then the rule's *set*s (`variables.<name>`) are made
  if it matches there — the variables in scope are part of what it matches (`variables.country is FR`) — and the run
  goes on. A const can be set by a rule (a mock overrides; Set Value at a stop still can't). One whose place is lost or
  only uncertain doesn't apply; the Rules view shows a placed rule's line, and a lost one as broken.

## Toward JSON Schema

A standard instead of a private vocabulary, at three levels:

- **The files are validated by a schema** — silo publishes the policy file's JSON Schema; VS Code's JSON support then
  completes and checks `.silo/policy.json` and `.silo/<you>.policy.json` by hand, with nothing of ours to build.
- **An argument's input is drawn from its schema**, not a component per argument type: a string is a text box (with
  `format: "glob"`, a glob), an `enum` a select, an array a list with *+* and *−*, an object its fields — one renderer,
  as JSON Forms and react-jsonschema-form do. A target declares the schema of the value it yields (a capability: an
  `enum`; a resource: a string; process.argv: an array of strings), and its operators follow from it (a string: *is*,
  *is not*, *matches*, *contains*; an `enum`: *is*, *is any of*; an array: *contains*, *is*); an action declares its
  argument's schema the same way (*give* takes the target's).
- **The *when* is stored as rows and compiled to JSON Schema** (decided 2026-10-06). Stored as rows — `{ logicalType_id,
  predicates: [{ target_id, operator_id, argument }] }`, ui-predicate's shape — because rows round-trip with the editor
  exactly and keep what was meant (*matches* `/workspace/**` stays a glob); a hand-written schema can use keywords no
  row shows (`if`/`then`, `$ref`, a nested `not`), and a glob kept as a schema is either a regex (`^/workspace/`) or a
  custom keyword no standard tool reads. Compiled, because then matching is schema validation — a standard validator
  (ajv) evaluates a rule, not an evaluator of ours — and the compiled schema is what's exported to other tools. Each
  operator in the catalog says what it compiles to: *is* → `const`, *is any of* → `enum`, *matches* → `pattern` (the
  glob compiled), *contains* → `contains`, *all* / *any* → `allOf` / `anyOf`, a negated operator → `not`. A row whose
  argument *is* a JSON Schema is the escape hatch for what the catalog doesn't offer. The two other levels — the files
  validated by a published schema, and every argument's input drawn from its schema — hold either way, and are where
  most of the tooling is.

## ui-predicate itself

Take its model (and keep our JSON compatible with it), not its packages: the React adapter's peers are React 16/17
and it pins core 0.6.4; the core brings ramda, `option`, `error-ex` and Node's `events` for an editing API small
enough to own, and it has no notion of actions. Revisit if its core grows actions or a vanilla renderer.

## Open

- Does a breakpoint condition (VS Code's own) become a rule's *when*, with *stop* as its action — one model for
  stopping and deciding?
- Healing a re-placed rule's reference in the file on its own (SPAN-ANNOTATIONS.md D4): today a rule found by a
  strategy other than its id applies, and is rewritten only when re-placed by hand.
- Recording more seams than a preview's fetch: a node service's reads and commands (almostnode), so their results can
  be given too.
- How the margin shows that a rule applies on a line (a mark in the gutter column, beside coverage?).
