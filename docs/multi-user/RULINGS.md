# Rem's rulings on the multi-user plan

Each ruling names the PLAN.md section 18 decision it settles. Lanes building a phase read this beside PLAN.md; a
ruling here overrides the plan's recommendation where they differ.

## Oct 15, 2026, 12:26 PM

- **Decision 22, friends' history: kept indefinitely while they stay connected.** Rem: "friends' history is kept
  indefinitely. That's the whole point ... I don't think these songs take up much space." So no idle pause and no
  12-month deletion. What still applies, because Spotify's terms require it whatever the retention: a friend who
  disconnects has their data deleted within five days, backups included (Developer Terms, Data Protection Appendix
  §5; 01f-platform.md §1.5). The terms also say "Do not store Spotify Content indefinitely" (Section IV); 01f §1.5
  reads that as defensible for one person's own history and weaker for several people's. Rem has taken that risk.
- **Decision 25, the privacy policy: later.** Not needed while Rem is the only user. Spotify's terms require a privacy
  policy and an end-user agreement shown before anyone else signs up (Section V), so both are due before Phase 4a's
  canary account; tracked in .claude/QUEUE.md.

## Oct 15, 2026, 12:46 PM

- **Sign-up is a request form, and Rem adds people by hand.** Spotify's User Management allows five accounts, Rem
  included, so up to four friends. Rem: "a form somewhere in the site ... as you sign up for it, you would have to put
  in some name. The name doesn't really matter ... Name can be optional ... if there's no name submitted, then we just
  put some sort of filler thing in there ... the email, and then we add them in, and then it's all good." So a friend's
  first visit asks for an email (required: the one on their Spotify account, which is what User Management matches)
  and a name (optional; a filler when blank); Rem sees the requests and adds the email in Spotify's dashboard; after
  that the friend connects with Spotify as usual. At most four friends while the app is in development mode.
- **Decision 1 done.** AUTH_SECRET rotated at 12:46 PM with separate Production and Preview values, production
  redeployed at 12:47 PM; every older session cookie, the Oct 14 second account's included, is void. The deployments
  built before the rotation are deleted a day later (PLAN.md decision 1).

## Oct 15, 2026, 12:43 PM

- **Decision 25, revised: make the privacy policy now, short and plain.** Rem: "go and make the privacy policy.
  Have it be whatever ... just a different place to press accept." Lane 2011_lb_privacy builds /privacy and /terms
  (with Spotify's required end-user terms) and a consent line beside the login page's connect button. Short, but
  true to what the code does: it promises nothing the app does not have.
