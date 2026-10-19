# Common ground demo API

Local demo server for the iOS preview. JSON over HTTP, no auth, loopback only.
Base URL comes from the `KORDI_COMMON_GROUND_URL` environment variable
(default `http://127.0.0.1:18190`). One tester ("you") plus 20 simulated
researchers. Slow calls (card build, room results) can take 10-60 s the first
time; later calls are cached.

## Types

```
Card    { working_on: [String], interests: [String], can_help: [String], looking_for: [String], hidden: [String], profile: Profile }
Profile { latest: [String],                  // up to 6 topics, most active recently first (ACT-R recency)
          earlier: [String],                 // past topics with no recent evidence; not used for matching
          timeline: [{ period: String, topics: [String] }],   // "2026 Q3", newest first
          topics: { [label]: { refs: [String], first_seen: String?, last_seen: String?, score: Double? } },
          evidence: { [id]: Evidence } }
Evidence { source: String, title: String, date: String?, url: String?, snippet: String }   // date "YYYY-MM-DD"
Person  { id: String, name: String, lab: String }
Ranked  { person: Person, score: Int, headline: String }          // score 0-100, room-relative
Topic   { label: String, people: [Person] }                        // people may include you (id "me")
Reason  { topic: String, their_topic: String, why: String }
```

Errors: non-2xx with `{ "error": String }`.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/me` | | `{ name: String, card: Card?, github: String }` `github` is the connected account ("" when none); clients add `github.com/<login>` to `links` when building |
| GET | `/v1/me/sources` | | `{ agents: [{ label: String, chars: Int }] }` files the agent import would read on this Mac |
| POST | `/v1/me/card/build` | `{ use_agents: Bool, links: String, notes: String, device: [{ source: String, items: [{ title: String, date: String? }] }]? }` | `{ card: Card, used: [String], skipped: [{ source: String, reason: String }] }` |
| PUT | `/v1/me/card` | `{ working_on, interests, can_help, looking_for: [String] }` | `{ card: Card }` replaces the topics after the tester removes or adds tags (max 10 per list, 60 chars each); a new tag gets an "Added by you" reference |
| PUT | `/v1/me/card/hidden` | `{ hidden: [String] }` | `{ card: Card }` |
| POST | `/v1/rooms/{code}/join` | | `{ code: String, members: [Person] }` simulated people keep arriving for ~15 s |
| GET | `/v1/rooms/{code}` | | `{ code: String, members: [Person] }` poll about once a second while in the lobby |
| POST | `/v1/rooms/{code}/results` | | `{ people: [Ranked], topics: [Topic], suggestion: Topic? }` |
| GET | `/v1/match/{person_id}` | | `{ person: Person, score: Int, shared: [Reason], you_bring: [Trade], they_bring: [Trade], next_step: String }` Trade `{ topic: String, for: String }`: a skill offered and the other person's topic it helps (their looking for, working on, or interests), confirmed by the LLM judge |
| POST | `/v1/tap` | | `{ person: Person }` the simulated person whose phone you tapped |
| POST | `/v1/connect/github` | | `{ status, user_code, verification_uri, login }` starts GitHub's device sign-in: show `user_code`, open `verification_uri` |
| GET | `/v1/connect/github` | | `{ status: "idle"\|"pending"\|"done"\|"denied"\|"expired", user_code?, verification_uri?, login: String }` poll every 2 s while pending |
| DELETE | `/v1/connect/github` | | `{ status: "idle", login: "" }` disconnects |
| GET | `/v1/recent` | | `{ people: [Ranked] }` people you opened a match with, newest first |

`members` never includes you. Card build needs at least one source (agents,
links, device titles, or notes). `device` carries titles and dates the app read on the phone after the user allowed access (calendar event start, reminder due date; plain strings are still accepted). Every card topic cites the evidence behind it in `profile.topics[label].refs`. `links` holds URLs and text separated by `;`; public pages are read once, sites that need sign-in are listed in `skipped`; without a card, rooms, tap, and matches return 409.
