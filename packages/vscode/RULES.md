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
  policy (lib: util/silo/policy.ts) — today's `{ capability, resource, disposition }` rule is a rule with two
  comparisons and one action, so existing policy files keep working. Saved in the same files: the shared contract
  (`.silo/policy.json`) and mine (`.silo/<you>.policy.json`); a recorded value (a real fetch response) in
  `.silo/local/`, referred to by the rule.
- **One editor**, in the component (vanilla DOM, VS Code-styled: the workbench realm loads no Web Awesome and no React
  but in islands): rows of selects and argument inputs, *all/any*, *+* and *−*, and an actions list.
- **Two places it opens**: a **Rules** view listing every rule (replacing the Capability calls panel's editing), and
  **inline in the margin**, anchored to a line, prefilled from what's there — a capability stop opens it with the
  call's capability and resource and *allow* chosen; a value's row with its target and *give*. The margin keeps entry
  points (one small control on a row), not forms.

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
- **Maybe the *when* itself is a JSON Schema** — over what the run reached (`{ capability, resource, program, … }`):
  *is* → `const`, *is any of* → `enum`, *matches* → `pattern` (a glob compiled to one), *contains* → `contains`, *all* /
  *any* → `allOf` / `anyOf`. Matching is then schema validation, and a rule reads the same in any tool. The editor's
  rows are a view of that schema; the open question is whether every row the editor offers has a faithful keyword (it
  does for these operators; ranges, dates and negation need `minimum`, `format`, `not`).

## ui-predicate itself

Take its model (and keep our JSON compatible with it), not its packages: the React adapter's peers are React 16/17
and it pins core 0.6.4; the core brings ramda, `option`, `error-ex` and Node's `events` for an editing API small
enough to own, and it has no notion of actions. Revisit if its core grows actions or a vanilla renderer.

## Open

- Does a breakpoint condition (VS Code's own) become a rule's *when*, with *stop* as its action — one model for
  stopping and deciding?
- The catalog's first entries: capability, resource, program, process.argv, a variable at a stop — and which
  argument types they need (text, glob, literal, a list of cases, a recorded value).
- How the margin shows that a rule applies on a line (a mark in the gutter column, beside coverage?).
