## Before you spend time on this

**Depth takes pull requests by invitation.** It is a single-author library and
stays that way on purpose. If you have not been asked for a PR on a specific
issue, this one will most likely be closed with thanks and reopened as an issue
— which is not a judgement on the code, just how this repo works.

The fastest route for a bug you have already fixed locally: open an issue with
the diff in it. If a PR is the right way to land it, you will be asked.

Invited PRs, carry on.

---

**What this changes**

<!-- and why. the diff already shows what; the why is the part that gets lost. -->

**Linked issue**

Closes #

**Checklist**

- [ ] `npm run dist` passes
- [ ] `npm test` passes
- [ ] Commit messages follow Conventional Commits (`fix(renderer): ...`)
- [ ] Any new name in `src/core/index.ts` is one consumers actually need — every
      export is a promise that survives to 1.0
- [ ] Breaking changes are called out with a `BREAKING CHANGE:` footer
