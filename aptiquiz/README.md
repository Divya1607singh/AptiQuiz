# AptiQuiz — Live Multiplayer Aptitude Arena

A runnable hackathon MVP for real-time aptitude practice. Teachers create quiz rooms without being counted as players; students join with a short code, answer timed questions, review answers after the quiz, and then see the final leaderboard. Includes a question studio, reconnect support, college league, and a 50-client smoke-test script.

## Features implemented

- **Question studio:** Create/edit question text, 2–6 options, correct answer, topic, difficulty and explanation. Reorder questions and reuse them in future rooms. Question bank persists in `data/questions.json`.
- **Rooms and lobby:** Five-character room code, separate teacher controls, student name + college, live participant list, 50-student limit.
- **Live game:** Server controls the question deadline and scoring. The next question starts as soon as all connected students answer, or when the timer expires. Correct answers remain hidden until the quiz ends.
- **Scoring:** Correct answers earn `max(100, round(1000 × (1 − adjusted_answer_time / question_duration)))`. Wrong answers and unanswered questions earn 0. A 150 ms receipt-jitter allowance is subtracted from answer time to reduce tiny network timing differences. The rule is intentionally simple and visible in the UI/README.
- **Answer review and leaderboard:** After the final question, students see the complete answer review and explanations first, followed by the final leaderboard with rank, points, accuracy and average answer time.
- **College league:** Completed room results contribute to player and college point tables stored in `data/store.json`.
- **Reconnect:** A refreshed/disconnected player can rejoin using the same room code, name and college; score and current game state remain on the server while the process and room exist.
- **Cheating resistance:** Correct answers are not sent before reveal; options are shuffled per player and frozen for each question; duplicate and late answers are ignored; the server validates answer indexes and computes scores. The browser does not choose the deadline or score.
- **Spectator event:** The Socket.IO server supports a `spectator:join` event for a projector display (the included UI focuses on player/host screens).
- **Accessible basics:** Responsive layout, large answer targets, sound not required, status text not conveyed by color alone.

## Requirements

- Node.js 18 or later
- npm

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>. Open multiple tabs or use multiple devices on the same network. To access from another device, run the server on a reachable machine and open `http://YOUR-LAN-IP:3000` from the other device; allow port 3000 through the machine firewall if needed.

### Quick demo

1. In one browser, the teacher creates a quiz room. The teacher is not a quiz participant.
2. Copy the five-character room code.
3. Open another tab/device and join with the code, a name and college.
4. The teacher starts the quiz from the teacher tab.
5. Students answer each question. The next question opens when all connected students have answered or the timer expires.
6. After the quiz, students review all correct answers and explanations, then see the final leaderboard.
6. Visit **Question studio** to add/edit/reorder questions. Visit **College league** after completing games.

## 50-client smoke test

In terminal 1:

```bash
npm start
```

In terminal 2:

```bash
npm run test:load
```

The test opens one teacher host and 50 student Socket.IO clients, waits for them to join, starts a room, and checks that all students and the teacher receive live room updates. It prints a PASS message when the smoke test completes. This is a **concurrency smoke test**, not a formal benchmark or a guarantee of production latency on every server. For a robust load report, run it on the target deployment, record CPU/memory and p95/p99 message latency, and repeat with network throttling.

## How fairness works under network delay

The server records the question's start time and deadline. A client submits only the selected option index; the server checks its own clock and ignores submissions received after the deadline. The score is calculated by the server from its measured receipt time, not from a client-supplied timestamp. A small 150 ms receipt-jitter allowance is subtracted from measured answer time so very small network differences are less punishing. This is a practical MVP compromise: it cannot perfectly know when a click happened on a remote device, and a large network delay can still disadvantage a player. A production system could use server-issued synchronized time samples, per-connection latency estimates, bounded compensation, event logs, and anti-abuse monitoring. Client-provided timestamps should never be trusted on their own.

## Architecture

- **Frontend:** HTML, CSS, vanilla JavaScript
- **Backend:** Node.js + Express
- **Real-time transport:** Socket.IO
- **Persistence:** JSON files (`data/questions.json`, `data/store.json`)
- **Load smoke test:** Node.js + `socket.io-client`

## API / events

- `GET /api/health` — health status and current room/question counts
- `GET /api/questions` — question bank
- `POST /api/questions` — create/update question
- `PUT /api/questions/order` — save question ordering
- `GET /api/league` — all-time player and college tables
- Socket events: `host:create`, `host:resume`, `player:join`, `game:start`, `answer:submit`, `room:resume`, `spectator:join`; server emits `room:update`, `host:created`, `player:joined`, `answer:ack`, `game:finished`, `app:error`.

## Limitations / next steps before production

This is a hackathon-ready starter, not a hardened public service. Rooms and live scores are in memory, so a server restart ends active games. JSON persistence is suitable for a demo but not concurrent multi-process deployment. There is no authentication, profanity moderation, rate limiting, distributed Socket.IO adapter, database migration, formal accessibility audit, or automated unit-test suite. A production college league should verify identities, use a database (for example PostgreSQL), store an audit log, rate-limit room creation and answers, and run multi-instance load tests. The question authoring endpoint is intentionally open for local hackathon use; secure it before public deployment.

## Suggested team split

- Frontend/UI: lobby, live question view, leaderboard and responsive styling.
- Backend/realtime: room state machine, deadline enforcement, scoring and reconnect.
- Questions/testing: question bank, authoring flow, league, README and load-test demo.

## License

MIT — see `LICENSE`.
