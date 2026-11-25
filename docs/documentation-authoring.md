# Writing PSO Web documentation

This guide is for maintainers of the English portal in `packages/cli/docs`. A page is useful when a reader can predict what a command changes, run the example, recognize its result and diagnose a different result.

## Choose the page's job

- **Tutorial:** takes a reader from stated prerequisites to a working, checked outcome. Include every file and registration needed for that outcome, or link to one named prerequisite procedure before the first command.
- **How-to:** solves one task for a reader who already has a workspace. State the starting state and the observable finish.
- **Concept:** explains the model and why PSO uses it. Use a small, accurate example to make the idea concrete; do not present it as a runnable project unless it is one.
- **Reference:** defines the accepted syntax, defaults, side effects, failure modes and version limits. Generate facts from source where practical.
- **Decision:** compares conditions and consequences, then points to the implementation path for each choice.

## Write a runnable path

For a hands-on page, use this order where it applies:

1. **Outcome:** name the endpoint, file, message or deployed state the reader will have.
2. **Starting state:** versions, tools, workspace, service, broker, database and keys. Distinguish required from optional.
3. **Commands and files:** show the working directory and complete imports. Mark generated files separately from files the reader creates or edits.
4. **Why this step exists:** explain the responsibility of each file before moving to the next layer.
5. **Run:** show the exact command and which process stays running.
6. **Observe:** show status, headers, body, logs, broker entry or database row, as appropriate. Name which values vary between runs.
7. **Verify:** give a command or request that distinguishes success from a merely valid declaration.
8. **Failure:** give the symptom, likely cause, check and recovery step for the failures a reader is likely to encounter.
9. **Next change:** show one meaningful variation and the production boundary.

A tutorial that leaves out required source files or configuration should say what it is: an overview or a partial exercise. A code block alone does not establish that the example works.

## Keep claims tied to evidence

- Use `evidence="verified"` only for output captured from a run or asserted by a relevant test. Keep an HTTP exchange internally consistent: a correlation ID in the response header must match the one in its error body.
- Use `evidence="expected"` for an outcome inferred from code or a contract that has not been captured. Say what can vary.
- Use `evidence="illustrative"` for placeholders and teaching shapes. Never use a real-looking token, hostname or success log to imply the sample was run.
- Use a `log` fence for readable log excerpts and `jsonl` for one JSON log object per line. Keep the level word (`INFO`, `WARN`, `ERROR`, etc.) or JSON `level` field in the text; the portal adds colour and a visible warning/error edge without changing copied output.
- Explain what a static command proves. `pso validate` checks declarations; it does not prove a service is healthy or that a database transaction succeeds.
- Keep security and database checks at their owning service even when the gateway performs an early check.

## Use screenshots with purpose

- Capture real PSO UI states. State the workspace state and whether processes were running. Do not make a stopped service look healthy.
- Put selectable commands, responses and JSON in text next to the image. A screenshot helps recognition; it is not the only source of instructions.
- Give every image descriptive alt text and a caption that points out one or two details the reader should notice.
- Keep screenshots under `packages/cli/portal/assets/screenshots/`. Refresh the curated set from the repository root with `npm run build` followed by `node scripts/capture-docs-screenshots.mjs` (Chrome or Edge required). Review the images before publishing because dynamic values and UI layout can change.
- Use `![description](@/assets/screenshots/name.png)` in portal Markdown. The site builder checks that the referenced asset exists.

## Review before publishing

Read the page as someone who has never seen PSO: can they tell which directory they are in, which command writes files, which file exposes the public route, why Spring checks the request again, and what they will see after running it? Check the command and API names against source, verify internal links, build the portal, and inspect desktop and mobile rendering when images or layout change.

## Where validation projects live

Examples that must run belong in `fixtures/<name>/` (see `fixtures/README.md`), not in the framework packages. When a page cites a fixture, link its README and name the command that runs it; never cite a path outside the repository.
