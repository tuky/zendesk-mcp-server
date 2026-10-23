# Contributing

Thanks for considering a contribution to this fork of Fruggr's
`zendesk-mcp-server`. The fork is maintained at `tuky/zendesk-mcp-server`; its
package is private and has no npm release. See the [README](README.md) for the
upstream and fork deployment paths.

## Review philosophy

This server is maintained primarily by a single developer who works with AI
assistance (Claude Code) to write code. **AI-assisted contributions are
welcome and explicitly accepted**, on one condition: every submitted change
has been read line by line and is owned by a human author who can defend it.

Every PR needs an author-side review and an independent code review. Automated
review applications may add findings when enabled, but are not a substitute for
reading the diff. Final responsibility for merging belongs to the human author.

External contributions follow the same standard.

Keep issues, pull requests and comments about this project. They are not a
channel for promoting another product or service, and neither are the
maintainers' contact details found in the commit history: no sales outreach.
Promotional content is removed; the contribution itself is judged on its merits.

## Development setup

### Toolchain

| Tool | Version | Source of truth |
| ---- | ------- | ---------------- |
| Node | 24 | [`.nvmrc`](.nvmrc), read by `nvm`, `fnm`, `mise`, `asdf`, `volta` |
| pnpm | 12 | [`package.json#packageManager`](package.json) (pinned with a corepack integrity hash) |

The toolchain (Node 24 + pnpm 12) is used to build, lint, type-check and test
the project. The package targets Node 22+ (see `engines.node`); CI installs
the packed tarball on Node 22 and runs the smoke test to verify that target.

The pnpm pin names one exact patch version, and
[`docs/decisions/pnpm-12-native.md`](docs/decisions/pnpm-12-native.md) says why:
pnpm 12 ships a native binary per host, and the ones Corepack can install there
differ from one patch release to the next.

```bash
# Clone, install, build
git clone https://github.com/tuky/zendesk-mcp-server.git
cd zendesk-mcp-server && pnpm install && pnpm build
node dist/index.js <your-subdomain>

# Dev mode, OAuth (browser opens on first tool call)
pnpm dev -- <your-subdomain> --mode all

# Dev mode, HTTP transport (OAuth bearer from the MCP client)
pnpm dev -- <your-subdomain> --transport http --port 3000 --public-url http://localhost:3000

# Build / typecheck / lint / test
pnpm build && pnpm typecheck && pnpm check && pnpm test
```

The fork is not published to npm. To test a PR branch, fetch it from the fork and
run the normal local checks:

```bash
git fetch origin my-feature-branch
git switch --detach FETCH_HEAD
pnpm install --frozen-lockfile
pnpm check && pnpm typecheck && pnpm test
```

Architecture, code style, submission bar and release workflow live in
[`AGENTS.md`](AGENTS.md).

## Before you start: avoid duplicate work

Two people building the same feature in parallel is wasted effort, and it has
happened here. Before writing any code for an issue:

1. **Check the issue is still live.** If it is closed as *completed* or labelled
   `released`, it already shipped. Stop there and, if a follow-up is needed, open
   a new issue for the delta.
2. **Search open *and* merged PRs for the issue number** (`is:pr #<n>`). A merged
   PR means it is done; an open PR means someone is mid-flight, so comment there
   and coordinate instead of starting your own.
3. **Claim it.** Self-assign the issue and leave a short "I'm picking this up"
   comment so others see it is taken.
4. **Open your PR as a draft as early as possible.** It is the earliest signal to
   others that the work is in flight.

## Opening a pull request

1. For an external contribution, fork this repository; otherwise work from its
   `main` branch.
2. Create a feature branch from `main`, following the naming guidance in
   [`AGENTS.md`](AGENTS.md).
3. Write code in small, reviewable commits.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for clear
   history; commit messages do not publish or version a release.
5. Make the author checklist below pass locally.
6. Push your branch and open a PR against this fork's `main`.

If the PR resolves an issue, link it in the PR **description** with a GitHub
closing keyword so the issue closes automatically when the PR merges to `main`:

```text
Closes #123
```

`close` / `closes` / `closed`, `fix` / `fixes` / `fixed` and
`resolve` / `resolves` / `resolved` all work. A bare `#123`, `Implements #123`
or `Part of #123` only *references* the issue, it does not close it. Keep the
keyword in the PR body (not just the title): the default squash merge discards
individual commit messages, but GitHub still reads closing keywords from the PR
description.

## Author checklist

The same checklist appears on the
[PR template](.github/pull_request_template.md):

- [ ] No open or merged PR already addresses the linked issue, and it is not
      already closed as completed / `released`.
- [ ] If the PR resolves an issue, its description links it with a closing
      keyword (`Closes #<n>`) so it auto-closes on merge to `main`.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm test:coverage` meets the thresholds.
- [ ] `pnpm check` is clean (Biome lint + format).
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` produces a clean bundle.
- [ ] You have read the diff yourself, line by line.
- [ ] You ran an independent author-side AI review on the diff.
- [ ] Documentation is updated if behavior or the tool surface changed
      (see [Documentation maintenance](AGENTS.md#documentation-maintenance)
      in `AGENTS.md`).
- [ ] If a new MCP tool was added, it is documented in
      `docs/mcp-tools-reference.md`.

## Code standards

- TypeScript with `@tsconfig/strictest`. No `any` escapes without a comment
  explaining why.
- Biome must be clean: `pnpm check` (and `pnpm check:fix` to auto-format). A
  pre-commit hook enforces this on staged files; `git commit --no-verify`
  bypasses it, and CI catches it either way.
- All `vitest` tests must pass: `pnpm test`.
- Coverage thresholds must hold: `pnpm test:coverage` (enforced in CI).
- Test-Driven Development is the default workflow:
  - **New features**: write a failing test first, then implement.
  - **Bug fixes**: write or adapt a test that reproduces the bug first, then
    fix the code.
  - **Existing tests are sacred**: a failing existing test is a potential
    regression. Investigate why before changing it. Never modify an existing
    test just to make it pass without understanding the root cause.
  - The Zendesk API is mocked with MSW handlers in `tests/msw-handlers.ts`.
    Never call the real API in tests.
- **Exact-output assertions use `toMatchInlineSnapshot`, committed filled.** An
  empty `toMatchInlineSnapshot()` is auto-filled on the next run and passes, so it
  asserts nothing — and under mutation testing it kills nothing, silently. Write
  it empty, run `pnpm test <file>` once, read what it wrote, commit that. A plain
  run is what fills an empty inline snapshot; reach for `-u` only to overwrite a
  filled one, since it re-baselines *every* stale snapshot in the file at once.
- **A `-u` on a formatter is a product-surface change, not a chore.** Those
  strings are what an MCP agent reads back, so re-baselining a snapshot changes
  the server's output. Re-read the diff the update produced and say in the PR why
  the new wording is right, exactly as for any other behaviour change.
- **Comments are optional, and explain the *why*, not the *how*.** The code is
  the first explanation; a comment that paraphrases it is noise. Keep an
  implementation comment under ~50 words, a `/** */` contract block under ~100 —
  longer rationale belongs in `docs/decisions/` with a one-line pointer from the
  code.
- Functional style: pure functions, immutable data, no classes (except
  `ZendeskApiError`). See `AGENTS.md` for the full architecture and
  conventions.

## Author-side AI review

Before pushing, run an AI review on the diff using a separate review context.
Suggested prompt:

> Read the diff between this branch and `main`. Look for: potential bugs,
> uncovered edge cases, inconsistencies with the project architecture,
> undocumented dependencies, security issues (secrets in cleartext,
> injections, missing zod validations), missing tests. Be strict.

Address everything Claude flags, or document in the PR description why
you're not addressing it.

## Submission quality bar

The bar to clear before opening a PR or asking the maintainer to review. It
applies the same way whether the code was written by a human or by an AI
assistant: the goal is that the patch survives external scrutiny and that the
human author can defend every line. The maintainer's review starts from the
assumption that everything below has already been done.

1. **Re-read your own diff in full.** No skimming. If a hunk no longer makes
   sense out of the context where you wrote it, rewrite it.
2. **Justify each change.** For every non-trivial hunk, you should be able to
   answer: why is this change here, what would break without it, and is it the
   smallest version of the fix.
3. **Look for what you didn't write.** Missing zod validation on an input,
   missing test for an edge case, missing README/AGENTS update on a renamed
   tool, missing error path. Reviewers find these, so find them first.
4. **Independent review.** Run an author-side AI review on the diff against
   `main`, then obtain a review from someone or a session that did not write the
   code. Address findings or document why you're deferring them.
5. **Run the full local gate**: `pnpm check`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`. A green CI on a non-green local run means a flaky check, not a
   free pass. If your PR changes anything under `src/`, also run the mutation
   gate on your diff, because CI does and it fails on a surviving mutant in a
   line you changed: `pnpm test:mutation:diff origin/main HEAD`. Background:
   [`docs/decisions/mutation-testing.md`](docs/decisions/mutation-testing.md).
6. **Scope discipline.** Don't bundle unrelated cleanups into a feature PR. If
   you spot something worth fixing along the way, note it and open a separate PR.
7. **No invented behavior.** If a Zendesk API field, an SDK option, or a library
   API isn't confirmed by the docs, an existing test, or a typed response, mark
   it `// TODO:` and surface the question in the PR description rather than
   guessing.
8. **Mark the PR ready for review.** Flip a draft PR to "ready for review" once
   dev is done and the local gate is green. Never leave it sitting as a draft.

## What happens after you open the PR

1. CI runs lint, typecheck, tests with coverage thresholds, build, and a smoke
   test (single `build-and-test` job in `.github/workflows/ci.yml`), plus the
   mutation gate on the lines your diff changed (`Changed lines` in
   `.github/workflows/mutation.yml`). The gate skips itself when the diff touches
   nothing it mutates, so a docs-only PR is unaffected — the canary step in the
   same job does not skip, because a PR the gate cannot judge is exactly what it
   is there for.
2. Automated review applications may post summaries and inline findings when
   enabled for the repository.
3. The maintainer reviews everything.
4. You address review findings.
5. Merge.

## Merge policy

- **Squash merge** is the default. Use a Conventional Commit title for clear
  history; it does not trigger a release.
- No force-push to `main`.
- Keep releases limited to reviewed, protected `fork-v*` tags.

## Releases

This fork does not publish to npm or the MCP Registry and does not release
automatically on merge to `main`. The maintainer's reviewed tag, image and
archive process is documented in [`docs/fork-releases.md`](docs/fork-releases.md).
[`docs/release-automation.md`](docs/release-automation.md) describes upstream
automation only.
