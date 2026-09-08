#!/bin/sh
# Point git at the repository's own hooks. Run once per clone.
#
# Hooks live in .githooks/ so they are version-controlled and reviewable;
# .git/hooks is not, which is why a rule that matters cannot live there.
set -e
git config core.hooksPath .githooks
printf '%s\n' "core.hooksPath -> .githooks"
printf '%s\n' "pre-commit will now refuse employer and machine-local commit identities."
