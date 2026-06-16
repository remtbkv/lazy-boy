# UI backup — Home + History merge (2026-06-13)

Snapshots taken before merging the History view into the Home page.

To revert the merge, copy these back:
  cp .ui-backup/home.page.tsx.bak       "src/app/(app)/home/page.tsx"
  cp .ui-backup/history-client.tsx.bak  src/components/history-client.tsx
  cp .ui-backup/history.page.tsx.bak    "src/app/(app)/history/page.tsx"

(Or `git checkout -- <path>` if unchanged since commit.)
